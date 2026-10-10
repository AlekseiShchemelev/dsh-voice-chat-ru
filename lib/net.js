/**
 * Транспортный слой: исходящие запросы к внешним движкам и входящие тела.
 *
 * Живёт отдельно от движков, потому что это единственное место, где нужен
 * таймаут, разбор ошибок соединения и ограничение размера тела — и раньше эти
 * правила применялись только к части движков, из-за чего у остальных оставался
 * бесполезный «fetch failed».
 *
 * @module dsh-voice-chat/net
 */

/**
 * Все исходящие запросы несут `Accept-Encoding: identity` (просим сервер не сжимать).
 * Повод: в процессе хоста на практике наблюдалось, что «body сжатого ответа
 * (gzip/chunked) съедался в пустоту» — тот же API и тот же ключ внутри хоста давали
 * `в ответе нет аудиоданных: {}`, а при прямом подключении мимо хоста всё работало
 * (страницы 404 от openresty у MiMo TTS/ASR и у производителей — это gzip, тогда
 * как 401 от siliconflow и открытый текст httpbin читаются нормально). Ответы
 * этих интерфейсов и так всего несколько десятков KB, так что отказ от сжатия
 * ничего не теряет, зато цепочка перестаёт зависеть от неизвестного поведения
 * распаковки ответов в процессе хоста.
 */
export const NO_COMPRESSION_HEADERS = { "Accept-Encoding": "identity" };

/**
 * Сколько символов текста реально уходит в синтез речи. Раньше лимит жил в
 * четырёх местах и различался (/tts — 2000, /speak — 2000, MiMo TTS — 2000),
 * из-за чего длинный ответ молча обрезался на середине и озвучивался не полностью.
 */
export const MAX_SPEECH_CHARS = 4000;

/**
 * fetch, который не превращает сетевую ошибку в бесполезное «fetch failed».
 *
 * Раньше TypeError от undici пролетал мимо всех обработчиков, и маршрут отвечал
 * 500 с текстом «fetch failed»: в консоли не было ни адреса, ни модели, ни
 * подсказки. Почти всегда это ровно три вещи — не поднялся локальный сервер
 * (порт в настройках разошёлся с запущенным), неверный адрес/ключ сетевого
 * движка или его недоступность из этой сети.
 */
export async function fetchDiagnostic(url, init, label, timeoutMs = 120_000) {
	try {
		// Таймаут обязателен: иначе «висящий» движок держит /stt или /speak
		// открытым бесконечно, и кнопка микрофона навсегда застревает
		// в состоянии «Распознавание…».
		return await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
	} catch (err) {
		const cause = err && err.cause && err.cause.code ? ` (${err.cause.code})` : "";
		const message = `${label}: не удалось соединиться с ${url}${cause}. `
			+ (/127\.0\.0\.1|localhost/.test(url)
				? "Локальный сервер не запущен или в настройках указан другой порт — "
					+ "проверьте блок «Локальный» в настройках голосового чата."
				: "Проверьте адрес и ключ движка, а также доступность сервиса из этой сети.");
		console.error(`[dsh-voice-chat] ${message}`, err);
		const wrapped = new Error(message);
		wrapped.status = 502;
		wrapped.cause = err;
		throw wrapped;
	}
}

/**
 * Отправка JSON POST с одной повторной попыткой на «пустой body» (то же самое:
 * внутри хоста изредка приходит пустой ответ). Возвращает
 * `{ ok, status, text, json }`, причём text сохраняется как есть, чтобы можно было
 * вписать настоящий ответ в текст ошибки.
 */
export async function postJson(url, headers, payload, label = "chat-интерфейс") {
	const send = async () => {
		// Через fetchDiagnostic: chat-протоколы (MiMo ASR/TTS) отдавали голое
		// «fetch failed» с кодом 500 — ровно то, что мы починили для multipart,
		// а эти два движка остались без диагностики.
		const resp = await fetchDiagnostic(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...NO_COMPRESSION_HEADERS, ...headers },
			body: JSON.stringify(payload)
		}, label);
		const text = await resp.text().catch(() => "");
		let json = {};
		try { json = JSON.parse(text); } catch { json = {}; }
		return { ok: resp.ok, status: resp.status, text, json, headers: resp.headers };
	};
	let result = await send();
	if (result.ok && result.text.trim() === "") {
		// Пустой 200: ещё одна попытка на новом соединении (на практике первый запрос внутри хоста может вернуть пустой body)
		console.warn("[dsh-voice-chat] получен пустой ответ, повторяем попытку:", url);
		result = await send();
	}
	return result;
}

/** Вписать сводку об ответе в текст ошибки, чтобы не видеть только «в ответе нет аудиоданных». */
export function describeResponse(result) {
	const headers = result.headers;
	const ce = headers?.get?.("content-encoding") || "-";
	const ct = headers?.get?.("content-type") || "-";
	const body = result.text ? `body[${result.text.length}]=${result.text.slice(0, 200)}` : "тело пустое";
	return `HTTP ${result.status} content-type=${ct} content-encoding=${ce} ${body}`;
}


/**
 * Сбор тела запроса с верхней границей размера.
 * Без неё POST /tts с ответом на сотни килобайт и POST /stt с длинной записью
 * буферизуются в память целиком и без ограничения — достаточно одного
 * кривого клиента, чтобы съесть память процесса хоста.
 */
export const MAX_BODY_BYTES = 128 * 1024 * 1024;
export async function readBody(req, limit = MAX_BODY_BYTES) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		total += chunk.length;
		if (total > limit) {
			const err = new Error(`Тело запроса больше ${Math.round(limit / 1024 / 1024)} МБ`);
			err.status = 413;
			throw err;
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}


export function json(res, status, payload) {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(payload));
}
