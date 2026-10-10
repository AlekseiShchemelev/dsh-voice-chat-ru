/**
 * Клиент протокола edge-tts: нативный WebSocket напрямую к сервису озвучивания
 * Microsoft Edge, без затрат на API. Протокол повторяет текущую версию
 * опенсорсного edge-tts: токен Sec-MS-GEC генерируется локально алгоритмом DRM
 * (SHA256(файловое время Windows + TrustedClientToken), окно 5 минут), запрос
 * токена к эндпоинту больше не делается.
 *
 * Источник: встроено из dsh-voice@0.1.0 (MIT, автор STARDUSTLC666,
 * https://github.com/STARDUSTLC666/dsh-voice), оставлено только то, что нужно
 * для синтеза, убран https-proxy-agent (плагин не использует прокси).
 *
 * @module dsh-voice-chat/edge-tts
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WS_BASE = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const SEC_MS_GEC_VERSION = '1-143.0.3650.75';
const WIN_EPOCH_SECONDS = 11644473600;
const WSS_HEADERS = {
	Pragma: 'no-cache',
	'Cache-Control': 'no-cache',
	Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
	'Accept-Encoding': 'gzip, deflate, br, zstd',
	'Accept-Language': 'en-US,en;q=0.9',
	'Sec-WebSocket-Version': '13',
	'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
};
/** Локальная генерация токена Sec-MS-GEC (соответствует DRM-алгоритму edge-tts). */
export function generateSecMsGec(nowSeconds = Date.now() / 1000) {
	let ticks = Math.floor(nowSeconds) + WIN_EPOCH_SECONDS;
	ticks -= ticks % 300;
	const windowsTicks = ticks * 10000000;
	const raw = String(windowsTicks) + TRUSTED_CLIENT_TOKEN;
	return createHash('sha256').update(raw, 'ascii').digest('hex').toUpperCase();
}
/** Экранирование XML. */
function escapeXml(text) {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/** Генерация SSML. */
export function buildSsml(options) {
	// xml:lang берётся из префикса голоса (zh-CN-XiaoxiaoNeural → zh-CN) и должен
	// завершаться на "-" или "$", иначе голоса без языкового префикса вроде "alloy"
	// обрежутся до недопустимого языкового тега "all".
	const m = /^([a-z]{2,3})(?:-([A-Za-z]{2}))?(?=-|$)/.exec(options.voice ?? '');
	const lang = m ? m[1] + (m[2] ? '-' + m[2].toUpperCase() : '') : 'ru-RU';
	return "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='" + lang + "'><voice name='" + options.voice + "'><prosody pitch='" + options.pitch + "' rate='" + options.rate + "' volume='+0%'>" + escapeXml(options.text) + '</prosody></voice></speak>';
}
/** Заголовок протокольного сообщения: временная метка плюс поля. */
function protocolHeader(path, extra) {
	const lines = ['X-Timestamp:' + new Date().toISOString()];
	for (const [key, value] of Object.entries(extra))
		lines.push(key + ':' + value);
	lines.push('Path:' + path);
	return lines.join('\r\n') + '\r\n\r\n';
}
/**
 * Синтез речи, возвращает байты MP3 (Buffer).
 * @throws При пустом/слишком длинном тексте, сбое соединения, таймауте или
 * отсутствии аудиоданных выбрасывается ошибка.
 */
export async function synthesizeSpeech(options, timeoutMs = 30000) {
	if (options.text.trim() === '')
		throw new Error('Текст для синтеза пуст.');
	if (options.text.length > 5000)
		throw new Error('Текст слишком длинный (более 5000 символов), разбейте на части.');
	const token = generateSecMsGec(Date.now() / 1000);
	// По актуальному протоколу edge-tts: Sec-MS-GEC идёт параметром запроса, MUID — заголовком
	const url = WS_BASE + '?TrustedClientToken=' + TRUSTED_CLIENT_TOKEN + '&ConnectionId=' + randomUUID().replace(/-/g, '') + '&Sec-MS-GEC=' + token + '&Sec-MS-GEC-Version=' + SEC_MS_GEC_VERSION;
	const socket = new WebSocket(url, {
		headers: { ...WSS_HEADERS, MUID: randomBytes(16).toString('hex').toUpperCase() },
	});
	const chunks = [];
	let done = false;
	await new Promise((resolvePromise, reject) => {
		const timer = setTimeout(() => {
			try {
				socket.close();
			}
			catch { /* игнорировать */ }
			reject(new Error('Таймаут синтеза речи (' + timeoutMs + ' мс без полного аудио), попробуйте снова или проверьте сеть.'));
		}, timeoutMs);
		const finish = () => { clearTimeout(timer); resolvePromise(); };
		socket.addEventListener('open', () => {
			const config = protocolHeader('speech.config', { 'Content-Type': 'application/json; charset=utf-8' })
				+ JSON.stringify({
					context: {
						synthesis: {
							audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: OUTPUT_FORMAT },
						},
					},
				});
			const ssml = protocolHeader('ssml', { 'Content-Type': 'application/ssml+xml', 'X-RequestId': randomUUID() }) + buildSsml(options);
			try {
				socket.send(config);
				socket.send(ssml);
			}
			catch (error) {
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
		socket.addEventListener('message', (event) => {
			const data = event.data;
			if (typeof data === 'string') {
				if (data.includes('Path:turn.end')) {
					if (chunks.length === 0) {
						clearTimeout(timer);
						reject(new Error('Синтез завершён, но аудиоданные не получены (сервер мог отклонить запрос).'));
					}
					else if (!done) {
						done = true;
						finish();
					}
				}
				return;
			}
			// Бинарный кадр: 2 байта заголовка big-endian с длиной + текст заголовка + аудиоданные
			const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
			if (buffer.length > 2) {
				const headerLength = buffer.readUInt16BE(0);
				if (buffer.length > 2 + headerLength) {
					chunks.push(buffer.subarray(2 + headerLength));
				}
			}
		});
		socket.addEventListener('error', () => {
			clearTimeout(timer);
			reject(new Error('Ошибка подключения edge-tts WebSocket. Если сети нужен прокси, настройте его и перезапустите.'));
		});
		socket.addEventListener('close', () => {
			if (!done) {
				clearTimeout(timer);
				if (chunks.length > 0) {
					done = true;
					finish();
				}
				else {
					reject(new Error('edge-tts соединение закрыто до получения аудио.'));
				}
			}
		});
	});
	const audio = Buffer.concat(chunks);
	if (audio.length === 0)
		throw new Error('Результат синтеза пуст.');
	return audio;
}