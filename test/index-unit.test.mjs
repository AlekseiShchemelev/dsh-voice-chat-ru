/**
 * Самотест половины хоста dsh-voice-chat: нормализация настроек, очистка текста
 * перед озвучкой, определение формата аудио, разбор ответов ASR, токен/SSML edge-tts.
 * Полностью офлайн: интеграционные сценарии ASR бьют только по поддельной службе на
 * локальном node:http, а edge-tts не ходит в сеть. Запуск: node test/index-unit.test.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import {
	ASR_ENGINE_DEFAULTS,
	DEFAULT_HOTKEY,
	DEFAULT_LOCAL_PORT,
	LOCAL_ASR_MODELS,
	TTS_ENGINE_DEFAULTS,
	LOCAL_TTS_VOICES,
	buildPublicSlots,
	cleanForTts,
	detectAudioMime,
	hotkeyFromEvent,
	hotkeyLabel,
	isLocalEngine,
	localPort,
	migrateLegacySettings,
	mergeSettings,
	normalizeHotkey,
	parseChatContent,
	parseTranscriptionText,
	resolveAsrConfig,
	resolveTtsConfig,
	resolveTtsEngine,
	sanitizeSettings,
	synthesizeWithCustomTts,
	transcribe,
	transcribeWithChatAsr
} from "../lib/index.js";
import { buildSsml, generateSecMsGec } from "../lib/edge-tts.js";

let passed = 0;
function test(name, fn) {
	try {
		fn();
		passed += 1;
		console.log(`  ok  ${name}`);
	} catch (err) {
		console.error(`FAIL  ${name}`);
		console.error(err);
		process.exitCode = 1;
	}
}

/** Асинхронный сценарий: общие с test()/счётчиком/кодом выхода соглашения. */
function testAsync(name, fn) {
	return Promise.resolve()
		.then(fn)
		.then(() => {
			passed += 1;
			console.log(`  ok  ${name}`);
		})
		.catch((err) => {
			console.error(`FAIL  ${name}`);
			console.error(err);
			process.exitCode = 1;
		});
}

/** Корректный заголовок WAV длиной от 12 байт (только для определения формата и входа chat ASR). */
function wavHeader() {
	return Buffer.concat([
		Buffer.from("RIFF", "latin1"),
		Buffer.from([0x24, 0x00, 0x00, 0x00]),
		Buffer.from("WAVEfmt ", "latin1")
	]);
}

console.log("sanitizeSettings: silenceMs");
test("Нижняя граница 300ms", () => {
	assert.equal(sanitizeSettings({ silenceMs: 1 }).silenceMs, 300);
	assert.equal(sanitizeSettings({ silenceMs: -5000 }).silenceMs, 300);
});
test("Верхняя граница 15000ms", () => {
	assert.equal(sanitizeSettings({ silenceMs: 999999 }).silenceMs, 15000);
});
test("Значение внутри интервала и округление дробной части", () => {
	assert.equal(sanitizeSettings({ silenceMs: 2500 }).silenceMs, 2500);
	assert.equal(sanitizeSettings({ silenceMs: 1200.6 }).silenceMs, 1201);
});
test("Числовая строка обрабатывается как число", () => {
	assert.equal(sanitizeSettings({ silenceMs: "1800" }).silenceMs, 1800);
});
test("Нечисловая строка считается незаданной (null)", () => {
	assert.equal(sanitizeSettings({ silenceMs: "несколько" }).silenceMs, null);
});
test("null считается незаданным и не прижимается к нижней границе 300", () => {
	assert.equal(sanitizeSettings({ silenceMs: null }).silenceMs, null,
		"Number(null)=0 → старая реализация записала бы «очистку» как 300ms");
});
test("Пустая строка считается незаданной и не прижимается к нижней границе 300", () => {
	assert.equal(sanitizeSettings({ silenceMs: "" }).silenceMs, null);
});
test("Непереданный ключ не появляется (откат к цепочке значений по умолчанию)", () => {
	assert.equal("silenceMs" in sanitizeSettings({}), false);
});

console.log("\nsanitizeSettings: ratePercent");
test("Зажато в 50..200", () => {
	assert.equal(sanitizeSettings({ ratePercent: 0 }).ratePercent, 50);
	assert.equal(sanitizeSettings({ ratePercent: 9999 }).ratePercent, 200);
	assert.equal(sanitizeSettings({ ratePercent: 100 }).ratePercent, 100);
});
test("null/пустая строка считаются незаданными и не прижимаются к 50", () => {
	assert.equal(sanitizeSettings({ ratePercent: null }).ratePercent, null);
	assert.equal(sanitizeSettings({ ratePercent: "" }).ratePercent, null);
});
test("Нечисловая строка → null", () => {
	assert.equal(sanitizeSettings({ ratePercent: "быстро" }).ratePercent, null);
});

console.log("\nsanitizeSettings: нормализация имени движка");
test("asrEngine: регистр и пробелы прощаются", () => {
	assert.equal(sanitizeSettings({ asrEngine: "  MIMO " }).asrEngine, "mimo");
	assert.equal(sanitizeSettings({ asrEngine: "Groq" }).asrEngine, "groq");
});
test("ttsEngine: регистр и пробелы прощаются", () => {
	assert.equal(sanitizeSettings({ ttsEngine: " EDGE " }).ttsEngine, "edge");
	assert.equal(sanitizeSettings({ ttsEngine: "Custom" }).ttsEngine, "custom");
});
test("Неизвестный asrEngine → siliconflow", () => {
	assert.equal(sanitizeSettings({ asrEngine: "whisper.cpp" }).asrEngine, "siliconflow");
	assert.equal(sanitizeSettings({ asrEngine: "" }).asrEngine, "siliconflow");
});
test("Неизвестный ttsEngine → edge", () => {
	assert.equal(sanitizeSettings({ ttsEngine: "elevenlabs" }).ttsEngine, "edge");
	assert.equal(sanitizeSettings({ ttsEngine: null }).ttsEngine, "edge");
});

console.log("\nsanitizeSettings: слоты (неизвестный движок/неизвестное поле отбрасываются)");
test("Слот неизвестного движка отбрасывается целиком", () => {
	const out = sanitizeSettings({ asr: { gemini: { apiKey: "k" } }, tts: { fish: { voice: "v" } } });
	assert.deepEqual(out.asr, {});
	assert.deepEqual(out.tts, {});
});
test("Неизвестные поля слота отбрасываются, известные обрезаются", () => {
	const out = sanitizeSettings({ tts: { mimo: { apiKey: "  k  ", temperature: 0.7, format: "wav" } } });
	assert.deepEqual(out.tts.mimo, { apiKey: "k" });
});
test("Числа в слоте сохраняются строками (trim)", () => {
	const out = sanitizeSettings({ asr: { groq: { model: 123 } } });
	assert.deepEqual(out.asr.groq, { model: "123" });
});
test("Значение слота не объект — вырождается в пустой слот без ошибки", () => {
	assert.deepEqual(sanitizeSettings({ tts: { mimo: "не объект" } }).tts.mimo, {});
	assert.deepEqual(sanitizeSettings({ asr: [1, 2, 3] }).asr, {});
});
test("Слоты разных движков не влияют друг на друга", () => {
	const out = sanitizeSettings({ tts: { edge: { voice: "zh-CN-YunxiNeural" }, mimo: { apiKey: "mk" } } });
	assert.deepEqual(out.tts.edge, { voice: "zh-CN-YunxiNeural" });
	assert.deepEqual(out.tts.mimo, { apiKey: "mk" });
});

console.log("\nsanitizeSettings: белый список speechLang");
test("Четыре языка из белого списка сохраняются как есть", () => {
	for (const lang of ["ru-RU", "zh-CN", "en-US", "ja-JP"]) {
		assert.equal(sanitizeSettings({ speechLang: lang }).speechLang, lang);
	}
});
test("Значение вне списка → null (откат к ru-RU)", () => {
	assert.equal(sanitizeSettings({ speechLang: "de-DE" }).speechLang, null);
	assert.equal(sanitizeSettings({ speechLang: "ru" }).speechLang, null);
});
test("Пробелы по краям обрезаются до проверки", () => {
	assert.equal(sanitizeSettings({ speechLang: "  zh-CN  " }).speechLang, "zh-CN");
	assert.equal(sanitizeSettings({ speechLang: " ru-RU " }).speechLang, "ru-RU");
});
test("Нестрока (число/null) не принимается за корректный язык", () => {
	assert.equal(sanitizeSettings({ speechLang: 5 }).speechLang, null);
	assert.equal(sanitizeSettings({ speechLang: null }).speechLang, null);
});

console.log("\nsanitizeSettings: булевы поля и строка \"false\"");
test("autoSend: true/false как есть", () => {
	assert.equal(sanitizeSettings({ autoSend: true }).autoSend, true);
	assert.equal(sanitizeSettings({ autoSend: false }).autoSend, false);
});
test("autoSend: строка \"false\" → false", () => {
	assert.equal(sanitizeSettings({ autoSend: "false" }).autoSend, false);
});
test("autoSend: строка \"true\" → true", () => {
	assert.equal(sanitizeSettings({ autoSend: "true" }).autoSend, true);
});
test("rewrite: строка \"false\" → false", () => {
	assert.equal(sanitizeSettings({ rewrite: "false" }).rewrite, false);
	assert.equal(sanitizeSettings({ rewrite: "true" }).rewrite, true);
});
test("continuousMode: строка \"false\" → false", () => {
	assert.equal(sanitizeSettings({ continuousMode: "false" }).continuousMode, false);
});
test("Непереданные булевы ключи не появляются (не затирают сохранённые настройки)", () => {
	const out = sanitizeSettings({ silenceMs: 1000 });
	assert.equal("autoSend" in out, false);
	assert.equal("rewrite" in out, false);
	assert.equal("continuousMode" in out, false);
});

console.log("\nПустой ввод / null / undefined");
test("sanitizeSettings(null/undefined/массив/строка) → пустой патч", () => {
	assert.deepEqual(sanitizeSettings(null), {});
	assert.deepEqual(sanitizeSettings(undefined), {});
	assert.deepEqual(sanitizeSettings([]), {});
	assert.deepEqual(sanitizeSettings("nope"), {});
});
test("mergeSettings(null, патч) работает нормально", () => {
	const merged = mergeSettings(null, sanitizeSettings({ silenceMs: 1200 }));
	assert.equal(merged.silenceMs, 1200);
	assert.deepEqual(merged.asr, {});
	assert.deepEqual(merged.tts, {});
});
test("resolveAsrConfig / resolveTtsConfig не бросают на null-вводе", () => {
	assert.equal(resolveAsrConfig(null, null).engine, "siliconflow");
	assert.equal(resolveTtsConfig(null, null, "edge", "").engine, "edge");
	assert.equal(resolveTtsEngine(null, null), "edge");
});

console.log("\nПограничные случаи миграции/слияния");
test("Миграция: при ttsEngine=local голос уходит в local и не портит edge", () => {
	const m = migrateLegacySettings({ ttsEngine: "local", ttsVoice: "ru_RU-irina-medium" });
	assert.equal(m.tts.local.voice, "ru_RU-irina-medium");
	assert.equal(m.tts.edge, undefined, "Голос локального piper не должен попасть в слот Edge (Edge получил бы недопустимый голос)");
});
test("Миграция: при ttsEngine=browser и пустом голосе слот не создаётся", () => {
	const m = migrateLegacySettings({ ttsEngine: "browser", ttsVoice: "" });
	assert.deepEqual(m.tts, {});
});
test("Миграция: при ttsEngine=edge голос без Neural всё равно уходит в edge (голос текущего движка пользователя)", () => {
	const m = migrateLegacySettings({ ttsEngine: "edge", ttsVoice: "alloy" });
	assert.equal(m.tts.edge.voice, "alloy");
});
test("Миграция: пустые плоские ключи считаются незаданными (после trim пусто)", () => {
	const m = migrateLegacySettings({ ttsEngine: "custom", ttsBaseUrl: "   ", ttsApiKey: "  k  ", ttsVoice: "  " });
	assert.equal(m.tts.custom.baseUrl, "", "Пустой URL нормализуется в пустую строку, грязное значение не попадает");
	assert.equal(m.tts.custom.apiKey, "k");
	assert.equal(m.tts.custom.voice, undefined, "Пустой голос не создаёт слот voice");
	assert.equal(migrateLegacySettings({ ttsEngine: "custom", ttsBaseUrl: "   " }).tts.custom, undefined,
		"Все плоские ключи пустые → слоты не создаются вовсе");
});
test("Миграция: пустой ввод → пустые слоты", () => {
	const m = migrateLegacySettings(undefined);
	assert.deepEqual(m.asr, {});
	assert.deepEqual(m.tts, {});
});
test("Слияние: asr=null в патче не затирает сохранённый слот", () => {
	const saved = mergeSettings({}, sanitizeSettings({ asr: { groq: { apiKey: "gsk" } } }));
	const merged = mergeSettings(saved, sanitizeSettings({ asrEngine: "custom" }));
	assert.equal(merged.asr.groq.apiKey, "gsk");
});
test("Слияние: при ttsEngine=edge старые плоские URL/ключ не идут в edge, голос идёт в edge", () => {
	const saved = mergeSettings({}, sanitizeSettings({
		ttsEngine: "edge", ttsVoice: " zh-CN-XiaoxiaoNeural ", ttsBaseUrl: "http://x/v1", ttsApiKey: "k", ttsModel: "tts-1"
	}));
	assert.deepEqual(saved.tts.edge, { voice: "zh-CN-XiaoxiaoNeural" });
	assert.equal(saved.tts.custom, undefined);
});
test("Слияние: при ttsEngine=local старые плоские ключ и голос уходят в local", () => {
	const saved = mergeSettings({}, sanitizeSettings({
		ttsEngine: "local", ttsBaseUrl: "http://127.0.0.1:8765/v1", ttsApiKey: "lk", ttsVoice: "ru_RU-irina-medium"
	}));
	assert.deepEqual(saved.tts.local, {
		baseUrl: "http://127.0.0.1:8765/v1",
		apiKey: "lk",
		voice: "ru_RU-irina-medium"
	});
	assert.equal(saved.tts.edge, undefined);
});
test("Отдача: если ничего не сохранено, каждый движок получает встроенные значения", () => {
	const slots = buildPublicSlots({}, {}, "");
	assert.equal(slots.tts.edge.voice, "ru-RU-SvetlanaNeural");
	assert.equal(slots.tts.mimo.baseUrl, "https://api.xiaomimimo.com/v1");
	assert.equal(slots.asr.siliconflow.model, "FunAudioLLM/SenseVoiceSmall");
	assert.equal(slots.asr.local.baseUrl, "http://127.0.0.1:8765/v1");
});
test("Отдача: запасной голос Edge действует только в слоте edge и не утекает в custom", () => {
	const slots = buildPublicSlots({}, {}, "zh-CN-YunxiNeural");
	assert.equal(slots.tts.edge.voice, "zh-CN-YunxiNeural");
	assert.equal(slots.tts.custom.voice, "alloy");
});
test("Разбор: неизвестное имя движка TTS откатывается к встроенному значению, но поле engine сохраняется", () => {
	const cfg = resolveTtsConfig({}, {}, "unknown", "");
	assert.equal(cfg.engine, "unknown", "поле engine возвращается как есть — решает вызывающий");
	assert.equal(cfg.model, "", "У неизвестного движка нет своих значений → откат к дефолту edge (пустая модель)");
	assert.equal(cfg.voice, "ru-RU-SvetlanaNeural");
	assert.equal(cfg.baseUrl, "");
});

console.log("\ncleanForTts: markdown");
test("Блок кода удаляется целиком", () => {
	assert.equal(cleanForTts("```js\nconsole.log(1)\n```\nПривет"), "Привет");
});
test("Незакрытая ограда кода тоже удаляется целиком", () => {
	assert.equal(cleanForTts("текст ```js\nconsole.log(1)"), "текст");
});
test("Встроенный код: обратные кавычки убираются, содержимое остаётся", () => {
	assert.equal(cleanForTts("Инлайн `код` тут"), "Инлайн код тут");
});
test("Ссылка markdown остаётся только текстом", () => {
	assert.equal(cleanForTts("Ссылка [текст](http://a.b/c)"), "Ссылка текст");
});
test("Разделитель таблицы удаляется, вертикальная черта заменяется пробелом", () => {
	assert.equal(cleanForTts("| a | b |\n| --- | --- |\n| 1 | 2 |"), "a b\n1 2");
});
test("Маркер неупорядоченного списка удаляется, текст пункта остаётся", () => {
	assert.equal(cleanForTts("- пункт один\n+ пункт два"), "пункт один\nпункт два");
});
test("Маркер упорядоченного списка удаляется (в том числе цифра с запятой без пробела)", () => {
	assert.equal(cleanForTts("1. первый\n2、второй\n3) третий"), "первый\nвторой\nтретий");
});
test("Заголовки/выделение/цитаты очищаются без пробела в начале строки", () => {
	assert.equal(cleanForTts("# Заголовок"), "Заголовок");
	assert.equal(cleanForTts("> цитата"), "цитата");
	assert.equal(cleanForTts("**жирный** и _курсив_"), "жирный и курсив");
});

console.log("\ncleanForTts: эмодзи и декоративные символы");
test("Эмодзи удаляются (диапазон \u{1F000}-\u{1FAFF})", () => {
	assert.equal(cleanForTts("Привет 😀 мир 🚀🎉"), "Привет мир");
});
test("Диапазон декоративных символов удаляется (диапазон \u2600-\u27BF)", () => {
	assert.equal(cleanForTts("тест ☀ ★ ✈ ✿"), "тест");
});
test("Смешанные символы/стрелки заменяются пробелом, а не склеиваются в слово", () => {
	assert.equal(cleanForTts("A → B · C ✓"), "A B C");
});
test("Модификаторы цвета кожи и вариационные селекторы удаляются без остаточных суррогатов", () => {
	assert.equal(cleanForTts("да 👍🏽\uFE0F нет"), "да нет");
});

console.log("\ncleanForTts: пунктуация и пробелы");
test("Повторная пунктуация сжимается (！！！→！）", () => {
	assert.equal(cleanForTts("Ура！！！"), "Ура！");
	assert.equal(cleanForTts("Точка..."), "Точка.");
	assert.equal(cleanForTts("Дааааа,,,"), "Дааааа,", "Повтор полуширинной запятой тоже сжимается");
	assert.equal(cleanForTts("Пауза,,, да"), "Пауза, да");
});
test("Подряд идущие пробелы сжимаются в один", () => {
	assert.equal(cleanForTts("a     b"), "a b");
});
test("Пустая строка/пробелы/null/undefined → пустая строка", () => {
	assert.equal(cleanForTts(""), "");
	assert.equal(cleanForTts("   \t "), "");
	assert.equal(cleanForTts(null), "");
	assert.equal(cleanForTts(undefined), "");
});
test("Числа и нестроковый ввод не приводят к ошибке", () => {
	assert.equal(cleanForTts(123), "123");
});
test("Ввод из одних символов после очистки пуст", () => {
	assert.equal(cleanForTts("```\n**`\n```"), "");
});

console.log("\ndetectAudioMime");
test("RIFF/WAVE → audio/wav", () => {
	assert.equal(detectAudioMime(wavHeader()), "audio/wav");
});
test("Заголовок ID3 → audio/mpeg", () => {
	const buf = Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.alloc(20)]);
	assert.equal(detectAudioMime(buf), "audio/mpeg");
});
test("Синхросигнал кадра MPEG 0xFF 0xE0 → audio/mpeg", () => {
	assert.equal(detectAudioMime(Buffer.from([0xff, 0xe0, 0x00])), "audio/mpeg");
	assert.equal(detectAudioMime(Buffer.from([0xff, 0xfb, 0x90, 0x00])), "audio/mpeg");
});
test("Контейнер webm/прочие → пустая строка", () => {
	assert.equal(detectAudioMime(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8, 9])), "");
	assert.equal(detectAudioMime(Buffer.from("OggS")), "");
});
test("Слишком короткий буфер → пустая строка, без ошибки", () => {
	assert.equal(detectAudioMime(Buffer.alloc(0)), "");
	assert.equal(detectAudioMime(Buffer.from([0xff])), "");
	assert.equal(detectAudioMime(Buffer.from([0xff, 0xe0])), "audio/mpeg", "И 2 байт хватает для проверки синхросигнала");
});
test("Контейнер только с RIFF, но без WAVE — не wav", () => {
	assert.equal(detectAudioMime(Buffer.from("RIFF____AVI ")), "");
});

console.log("\nРазбор ответов ASR");
test("transcriptions: берётся поле text", () => {
	assert.equal(parseTranscriptionText({ text: " привет " }), " привет ");
});
test("transcriptions: нет text → пустая строка", () => {
	assert.equal(parseTranscriptionText({}), "");
	assert.equal(parseTranscriptionText(null), "");
	assert.equal(parseTranscriptionText("строка"), "");
});
test("chat: content — строка", () => {
	assert.equal(parseChatContent({ choices: [{ message: { content: "привет" } }] }), "привет");
});
test("chat: content — массив частей (склейка)", () => {
	assert.equal(parseChatContent({
		choices: [{ message: { content: [{ type: "text", text: "при" }, { type: "text", text: "вет" }] } }]
	}), "привет");
});
test("chat: в массив частей попали голые строки и нетекстовые блоки", () => {
	assert.equal(parseChatContent({
		choices: [{ message: { content: ["a", { type: "audio", audio: {} }, { text: "b" }, null] } }]
	}), "ab");
});
test("chat: choices отсутствует/пуст → пустая строка", () => {
	assert.equal(parseChatContent({}), "");
	assert.equal(parseChatContent({ choices: [] }), "");
	assert.equal(parseChatContent(null), "");
	assert.equal(parseChatContent({ choices: [{}] }), "");
});

console.log("\nИнтеграция ASR (локальная поддельная служба, без выхода в сеть)");
/** Поднимает локальную поддельную HTTP-службу ASR; обработчик получает (req, res, body) и сам решает, что ответить. */
function startFakeAsr(handler) {
	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => handler(req, res, Buffer.concat(chunks)));
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
		});
	});
}
const closeServer = (server) => new Promise((resolve) => server.close(resolve));

await testAsync("transcribe: multipart /audio/transcriptions возвращает text", async () => {
	let seen = null;
	const { server, baseUrl } = await startFakeAsr((req, res, body) => {
		seen = { url: req.url, auth: req.headers.authorization, body: body.toString("latin1") };
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ text: "  Привет, это тест  " }));
	});
	try {
		const text = await transcribe(Buffer.from([1, 2, 3]), {
			engine: "siliconflow", baseUrl: `${baseUrl}/v1`, model: "whisper", apiKey: "sk-test"
		});
		assert.equal(text, "Привет, это тест");
		assert.equal(seen.url, "/v1/audio/transcriptions");
		assert.equal(seen.auth, "Bearer sk-test");
		assert.match(seen.body, /name="model"[\s\S]*whisper/);
		assert.match(seen.body, /name="file"/);
	} finally {
		await closeServer(server);
	}
});

await testAsync("transcribe: завершающий слэш в baseUrl не даёт двойного слэша", async () => {
	let seenUrl = null;
	const { server, baseUrl } = await startFakeAsr((req, res) => {
		seenUrl = req.url;
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ text: "ok" }));
	});
	try {
		await transcribe(Buffer.from([1]), { engine: "custom", baseUrl: `${baseUrl}/v1/`, model: "m", apiKey: "k" });
		assert.equal(seenUrl, "/v1/audio/transcriptions");
	} finally {
		await closeServer(server);
	}
});

await testAsync("transcribe: нет apiKey → status 400, запрос не отправляется", async () => {
	await assert.rejects(
		() => transcribe(Buffer.from([1]), { engine: "siliconflow", baseUrl: "http://127.0.0.1:1/v1", model: "m", apiKey: "" }),
		(err) => {
			assert.equal(err.status, 400);
			assert.match(err.message, /ASR/);
			return true;
		}
	);
});

await testAsync("transcribe: апстрим 500 → status 502 с error.message", async () => {
	const { server, baseUrl } = await startFakeAsr((req, res) => {
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: { message: "upstream boom" } }));
	});
	try {
		await assert.rejects(
			() => transcribe(Buffer.from([1]), { engine: "siliconflow", baseUrl: `${baseUrl}/v1`, model: "m", apiKey: "k" }),
			(err) => {
				assert.equal(err.status, 502);
				assert.match(err.message, /upstream boom/);
				return true;
			}
		);
	} finally {
		await closeServer(server);
	}
});

await testAsync("transcribe: не-JSON страница ошибки тоже попадает в текст ошибки", async () => {
	const { server, baseUrl } = await startFakeAsr((req, res) => {
		res.writeHead(502, { "Content-Type": "text/html" });
		res.end("<html>bad gateway</html>");
	});
	try {
		await assert.rejects(
			() => transcribe(Buffer.from([1]), { engine: "siliconflow", baseUrl: `${baseUrl}/v1`, model: "m", apiKey: "k" }),
			(err) => {
				assert.equal(err.status, 502);
				assert.match(err.message, /bad gateway/);
				return true;
			}
		);
	} finally {
		await closeServer(server);
	}
});

await testAsync("transcribe: пустое тело ответа → status 502", async () => {
	const { server, baseUrl } = await startFakeAsr((req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end("");
	});
	try {
		await assert.rejects(
			() => transcribe(Buffer.from([1]), { engine: "siliconflow", baseUrl: `${baseUrl}/v1`, model: "m", apiKey: "k" }),
			(err) => {
				assert.equal(err.status, 502);
				assert.match(err.message, /пустой ответ/);
				return true;
			}
		);
	} finally {
		await closeServer(server);
	}
});

await testAsync("transcribe: engine=mimo автоматически идёт по протоколу chat", async () => {
	let seen = null;
	const { server, baseUrl } = await startFakeAsr((req, res, body) => {
		seen = { url: req.url, body: JSON.parse(body.toString("utf8")) };
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ choices: [{ message: { content: " из mimo " } }] }));
	});
	try {
		const text = await transcribe(wavHeader(), {
			engine: "mimo", baseUrl: `${baseUrl}/v1/chat/completions`, model: "mimo-v2.5-asr", apiKey: "mk"
		});
		assert.equal(text, "из mimo");
		assert.equal(seen.url, "/v1/chat/completions");
		assert.equal(seen.body.messages[0].content[0].input_audio.format, "wav");
		assert.match(seen.body.messages[0].content[0].input_audio.data, /^data:audio\/wav;base64,/);
	} finally {
		await closeServer(server);
	}
});

await testAsync("transcribe: baseUrl, оканчивающийся на /chat/completions, тоже идёт по протоколу chat", async () => {
	let seenUrl = null;
	const { server, baseUrl } = await startFakeAsr((req, res) => {
		seenUrl = req.url;
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ choices: [{ message: { content: [{ text: "ку" }, { text: "сок" }] } }] }));
	});
	try {
		const text = await transcribe(wavHeader(), {
			engine: "custom", baseUrl: `${baseUrl}/v1/chat/completions/`, model: "m", apiKey: "k"
		});
		assert.equal(text, "кусок", "Массив частей в content тоже должен склеиваться");
		assert.equal(seenUrl, "/v1/chat/completions", "Завершающий слэш должен убираться");
	} finally {
		await closeServer(server);
	}
});

await testAsync("transcribe: у mp3-аудио в запросе chat используется формат mp3", async () => {
	let seen = null;
	const { server, baseUrl } = await startFakeAsr((req, res, body) => {
		seen = JSON.parse(body.toString("utf8"));
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ choices: [{ message: { content: "да" } }] }));
	});
	try {
		await transcribe(Buffer.from([0xff, 0xfb, 0x90, 0x00]), {
			engine: "mimo", baseUrl: `${baseUrl}/v1/chat/completions`, model: "m", apiKey: "k"
		});
		assert.equal(seen.messages[0].content[0].input_audio.format, "mp3");
	} finally {
		await closeServer(server);
	}
});

await testAsync("chat ASR: аудио не wav/mp3 → status 400", async () => {
	await assert.rejects(
		() => transcribeWithChatAsr(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]), {
			baseUrl: "http://127.0.0.1:1/v1/chat/completions", model: "m", apiKey: "k"
		}),
		(err) => {
			assert.equal(err.status, 400);
			assert.match(err.message, /wav\/mp3/);
			return true;
		}
	);
});

await testAsync("chat ASR: ошибка апстрима → status 502", async () => {
	const { server, baseUrl } = await startFakeAsr((req, res) => {
		res.writeHead(401, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: { message: "bad key" } }));
	});
	try {
		await assert.rejects(
			() => transcribeWithChatAsr(wavHeader(), { baseUrl: `${baseUrl}/v1/chat/completions`, model: "m", apiKey: "k" }),
			(err) => {
				assert.equal(err.status, 502);
				assert.match(err.message, /bad key/);
				return true;
			}
		);
	} finally {
		await closeServer(server);
	}
});

await testAsync("chat ASR: пустой JSON-объект → status 502 (без ошибки Object.keys)", async () => {
	const { server, baseUrl } = await startFakeAsr((req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end("{}");
	});
	try {
		await assert.rejects(
			() => transcribeWithChatAsr(wavHeader(), { baseUrl: `${baseUrl}/v1/chat/completions`, model: "m", apiKey: "k" }),
			(err) => {
				assert.equal(err.status, 502);
				return true;
			}
		);
	} finally {
		await closeServer(server);
	}
});

await testAsync("chat ASR: ответ JSON null → status 502 (без ошибки Object.keys)", async () => {
	const { server, baseUrl } = await startFakeAsr((req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end("null");
	});
	try {
		await assert.rejects(
			() => transcribeWithChatAsr(wavHeader(), { baseUrl: `${baseUrl}/v1/chat/completions`, model: "m", apiKey: "k" }),
			(err) => {
				assert.equal(err.status, 502, "Старая реализация падала бы на Object.keys(null) и отдавала 500");
				return true;
			}
		);
	} finally {
		await closeServer(server);
	}
});

console.log("\nedge-tts: токен Sec-MS-GEC (чистый расчёт, без сети)");
test("В одну секунду → один токен", () => {
	assert.equal(generateSecMsGec(1_700_000_000.4), generateSecMsGec(1_700_000_000.9));
});
test("Токен — 64-разрядный шестнадцатеричный прописной (SHA-256)", () => {
	assert.match(generateSecMsGec(1_700_000_000), /^[0-9A-F]{64}$/);
});
test("Стабилен в пределах одного 300-секундного окна (выравнивание окна)", () => {
	// Окно выравнивается по (unix + WIN_EPOCH) с шагом 300s; берём начало окна за базу
	const base = 1_700_000_000 - ((1_700_000_000 + 11_644_473_600) % 300);
	const token = generateSecMsGec(base);
	for (const offset of [0, 1, 60, 150, 299]) {
		assert.equal(generateSecMsGec(base + offset), token, `смещение ${offset}s должно попасть в то же окно`);
	}
});
test("Переход через границу 300-секундного окна → токен меняется", () => {
	const base = 1_700_000_000 - ((1_700_000_000 + 11_644_473_600) % 300);
	assert.notEqual(generateSecMsGec(base + 300), generateSecMsGec(base));
});
test("В разные моменты времени токен разный (сам момент участвует в расчёте)", () => {
	assert.notEqual(generateSecMsGec(1_700_000_000), generateSecMsGec(1_800_000_000));
});

console.log("\nedge-tts: SSML");
const ssml = (opts) => buildSsml({
	voice: "ru-RU-SvetlanaNeural", pitch: "+0Hz", rate: "+10%", text: "тест", ...opts
});

test("xml:lang берётся из префикса голоса (zh-CN-XiaoxiaoNeural)", () => {
	assert.match(ssml({ voice: "zh-CN-XiaoxiaoNeural" }), /xml:lang='zh-CN'/);
});
test("xml:lang берётся из префикса голоса (ru-RU-SvetlanaNeural)", () => {
	assert.match(ssml({}), /xml:lang='ru-RU'/);
});
test("Без языкового префикса в голосе — по умолчанию ru-RU", () => {
	assert.match(ssml({ voice: "alloy" }), /xml:lang='ru-RU'/);
});
test("voice name берёт полное имя голоса", () => {
	assert.match(ssml({ voice: "en-US-JennyNeural" }), /<voice name='en-US-JennyNeural'>/);
});
test("prosody несёт pitch и rate", () => {
	assert.match(ssml({ pitch: "+5Hz", rate: "-20%" }), /<prosody pitch='\+5Hz' rate='-20%' volume='\+0%'>/);
});
test("& < > экранируются", () => {
	const xml = ssml({ text: "A & B <tag> \"q\"" });
	assert.match(xml, /A &amp; B &lt;tag&gt; "q"/);
	assert.equal(xml.includes("A & B"), false);
});
test("Оборачивается в полный документ speak (version + xmlns)", () => {
	const xml = ssml({});
	assert.ok(xml.startsWith("<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis'"));
	assert.ok(xml.endsWith("</prosody></voice></speak>"));
});

// ---------- Локальный движок: ключ не нужен, порт берётся из адреса ----------

test("isLocalEngine: только движок local (с нормализацией регистра/пробелов)", () => {
	assert.equal(isLocalEngine("local"), true);
	assert.equal(isLocalEngine(" Local "), true);
	assert.equal(isLocalEngine("LOCAL"), true);
	assert.equal(isLocalEngine("browser"), false);
	assert.equal(isLocalEngine(""), false);
	assert.equal(isLocalEngine(undefined), false);
});

test("localPort: порт из 127.0.0.1:xxxx адреса слота", () => {
	assert.equal(localPort({}, "http://127.0.0.1:8765/v1"), 8765);
	assert.equal(localPort({}, "http://localhost:9000/v1"), 9000);
	// Адрес без порта → берём config.local.port, затем дефолт
	assert.equal(localPort({}, "http://127.0.0.1/v1"), 8765);
	assert.equal(localPort({ local: { port: 7777 } }, ""), 7777);
});

await testAsync("transcribe: движок browser → понятный отказ, а не «не настроен ключ»", async () => {
	// Браузерный движок работает через Web Speech API и сюда не должен попадать;
	// раньше он отваливался с жалобой на ключ, которая сбивала с толку
	await assert.rejects(
		() => transcribe(Buffer.from([1]), { engine: "browser", baseUrl: "", model: "", apiKey: "" }),
		(err) => {
			assert.equal(err.status, 400);
			assert.match(err.message, /Web Speech API/);
			assert.doesNotMatch(err.message, /ключ/i);
			return true;
		}
	);
});

await testAsync("transcribe: движок local без apiKey → запрос уходит, Authorization не шлём", async () => {
	let seen = null;
	const { server, baseUrl } = await startFakeAsr((req, res, body) => {
		seen = { url: req.url, auth: req.headers.authorization, body: body.toString("latin1") };
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ text: "локальный текст" }));
	});
	try {
		const text = await transcribe(Buffer.from([1, 2, 3]), {
			engine: "local", baseUrl: `${baseUrl}/v1`, model: "small", apiKey: ""
		});
		assert.equal(text, "локальный текст");
		assert.equal(seen.url, "/v1/audio/transcriptions");
		// Локальный сервер не проверяет ключ — заголовок не должен мешать
		assert.equal(seen.auth, undefined);
		assert.match(seen.body, /name="model"[\s\S]*small/);
	} finally {
		await closeServer(server);
	}
});

await testAsync("transcribe: язык из настроек уходит в форму (локальному Whisper он нужен)", async () => {
	let seen = null;
	const { server, baseUrl } = await startFakeAsr((req, res, body) => {
		seen = body.toString("latin1");
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ text: "ок" }));
	});
	try {
		await transcribe(Buffer.from([1]), {
			engine: "local", baseUrl: `${baseUrl}/v1`, model: "small", apiKey: "", language: "ru"
		});
		assert.match(seen, /name="language"[\s\S]*ru/, "язык должен уходить отдельным полем");
		// Без языка (автоопределение) поле не добавляется
		await transcribe(Buffer.from([1]), { engine: "local", baseUrl: `${baseUrl}/v1`, model: "small", apiKey: "" });
		assert.doesNotMatch(seen, /name="language"/);
	} finally {
		await closeServer(server);
	}
});

test("resolveAsrConfig берёт язык из общих настроек речи (ru-RU → ru)", () => {
	assert.equal(resolveAsrConfig({}, { asrEngine: "local", speechLang: "ru-RU" }).language, "ru");
	assert.equal(resolveAsrConfig({}, { asrEngine: "local", speechLang: "zh-CN" }).language, "zh");
	// Язык не задан → берётся тот же дефолт, который отдаёт publicSettings.
	// Раньше здесь было "", и faster-whisper угадывал язык сам: на русской речи
	// стабильно определял en (это была реальная жалоба «распознавание не работает»).
	assert.equal(resolveAsrConfig({}, { asrEngine: "local" }).language, "ru",
		"без явного языка — дефолт ru-RU, а не пустая строка");
	assert.equal(resolveAsrConfig({}, { asrEngine: "local", speechLang: null }).language, "ru");
});

await testAsync("transcribe: engine=browser без apiKey всё ещё 400 (не наш локальный движок)", async () => {
	await assert.rejects(
		() => transcribe(Buffer.from([1]), { engine: "browser", baseUrl: "http://127.0.0.1:1/v1", model: "", apiKey: "" }),
		(err) => err.status === 400
	);
});

await testAsync("synthesizeWithCustomTts: local без apiKey → запрос уходит, ключ не требуется", async () => {
	let seen = null;
	const { server, baseUrl } = await startFakeAsr((req, res, body) => {
		seen = { url: req.url, auth: req.headers.authorization, payload: JSON.parse(body.toString("utf8")) };
		res.writeHead(200, { "Content-Type": "audio/wav" });
		res.end(Buffer.from("RIFF0000WAVE", "latin1"));
	});
	try {
		const audio = await synthesizeWithCustomTts("привет", {
			engine: "local", baseUrl: `${baseUrl}/v1`, model: "piper", apiKey: "", voice: "ru_RU-irina-medium"
		});
		assert.equal(audio.length, 12);
		assert.equal(seen.url, "/v1/audio/speech");
		assert.equal(seen.auth, undefined);
		assert.equal(seen.payload.voice, "ru_RU-irina-medium");
	} finally {
		await closeServer(server);
	}
});

await testAsync("synthesizeWithCustomTts: custom без apiKey всё ещё 400", async () => {
	await assert.rejects(
		() => synthesizeWithCustomTts("привет", { engine: "custom", baseUrl: "http://127.0.0.1:1/v1", model: "tts-1", apiKey: "" }),
		(err) => err.status === 400
	);
});

// ---------- Горячая клавиша запуска распознавания ----------

console.log("\nГорячая клавиша (по умолчанию правый Ctrl)");

test("по умолчанию — правый Ctrl", () => {
	assert.equal(DEFAULT_HOTKEY, "ControlRight");
});

test("normalizeHotkey: одиночный модификатор принимается как есть", () => {
	assert.equal(normalizeHotkey("ControlRight"), "ControlRight");
	assert.equal(normalizeHotkey("controlright"), "ControlRight");
	assert.equal(normalizeHotkey("ShiftLeft"), "ShiftLeft");
});

test("normalizeHotkey: порядок модификаторов фиксирован", () => {
	assert.equal(normalizeHotkey("Shift+Ctrl+m"), "Ctrl+Shift+M");
	assert.equal(normalizeHotkey("Meta+Alt+Ctrl+k"), "Ctrl+Alt+Meta+K");
	assert.equal(normalizeHotkey("ctrl + space"), "Ctrl+Space");
});

test("normalizeHotkey: выключение и мусор", () => {
	assert.equal(normalizeHotkey(""), "");
	assert.equal(normalizeHotkey("none"), "");
	assert.equal(normalizeHotkey("off"), "");
	assert.equal(normalizeHotkey("Ctrl+A+B"), null, "две обычные клавиши — не сочетание");
	assert.equal(normalizeHotkey("Shift+Ctrl"), null, "без основной клавиши нельзя");
});

test("hotkeyFromEvent: событие → каноническая строка", () => {
	assert.equal(hotkeyFromEvent({ code: "ControlRight", ctrlKey: true, key: "Control" }), "ControlRight");
	assert.equal(hotkeyFromEvent({ code: "KeyM", ctrlKey: true, shiftKey: true, key: "M" }), "Ctrl+Shift+M");
	assert.equal(hotkeyFromEvent({ code: "Digit1", key: "1" }), "1");
	assert.equal(hotkeyFromEvent({ code: "Space", key: " " }), "Space");
});

test("hotkeyLabel: правый Ctrl читается по-русски", () => {
	assert.equal(hotkeyLabel("ControlRight"), "Правый Ctrl");
	assert.equal(hotkeyLabel("Ctrl+Shift+Space"), "Ctrl + Shift + Пробел");
	assert.equal(hotkeyLabel(""), "");
});

test("sanitizeSettings: asrHotkey нормализуется, мусор → значение по умолчанию", () => {
	assert.equal(sanitizeSettings({ asrHotkey: "shift+ctrl+m" }).asrHotkey, "Ctrl+Shift+M");
	assert.equal(sanitizeSettings({ asrHotkey: "off" }).asrHotkey, "");
	assert.equal(sanitizeSettings({ asrHotkey: "Ctrl+A+B" }).asrHotkey, DEFAULT_HOTKEY);
	assert.equal(sanitizeSettings({}).asrHotkey, undefined, "непереданный ключ не добавляется");
});

// ---------- Списки значений локального движка ----------

console.log("\nЛокальный движок: списки моделей и порт по умолчанию");

test("списки совпадают с тем, что принимает py/server.py", () => {
	// Русских голосов в piper-voices ровно четыре и все medium — проверено по
	// репозиторию (low/high/x_low отдают 404). Другие языки сервер принимает,
	// если голос скачан: список здесь только для «быстрых» русских.
	assert.deepEqual(LOCAL_ASR_MODELS, ["tiny", "base", "small", "medium", "large-v3"]);
	assert.deepEqual(LOCAL_TTS_VOICES, [
		"ru_RU-irina-medium", "ru_RU-ruslan-medium", "ru_RU-dmitri-medium", "ru_RU-denis-medium"
	]);
	const server = readFileSync(new URL("../py/server.py", import.meta.url), "utf8");
	for (const model of LOCAL_ASR_MODELS) {
		assert.ok(server.includes(`"${model}"`), `в server.py нет модели ${model}`);
	}
	for (const voice of LOCAL_TTS_VOICES) {
		assert.ok(server.includes(`"${voice}"`), `в server.py нет голоса ${voice}`);
	}
});

test("порт по умолчанию — 8765, и адрес движка на него смотрит", () => {
	assert.equal(DEFAULT_LOCAL_PORT, 8765);
	assert.equal(ASR_ENGINE_DEFAULTS.local.baseUrl, `http://127.0.0.1:${DEFAULT_LOCAL_PORT}/v1`);
	assert.equal(TTS_ENGINE_DEFAULTS.local.baseUrl, `http://127.0.0.1:${DEFAULT_LOCAL_PORT}/v1`);
	// Пустой слот (пользователь не трогал адрес) → берётся адрес движка по умолчанию
	assert.equal(resolveAsrConfig({}, { asrEngine: "local" }).baseUrl, `http://127.0.0.1:${DEFAULT_LOCAL_PORT}/v1`);
	assert.equal(resolveTtsConfig({}, { ttsEngine: "local" }, "local").baseUrl, `http://127.0.0.1:${DEFAULT_LOCAL_PORT}/v1`);
	// Нестандартный порт из слота — и адрес, и порт запускаемого сервера
	assert.equal(localPort({}, "http://127.0.0.1:9321/v1"), 9321);
});

console.log(`\n${passed} пройдено${process.exitCode ? " (есть падения)" : ""}`);