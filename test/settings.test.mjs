/**
 * Самотест слоя настроек dsh-voice-chat: настройки движков ASR/TTS должны быть изолированы
 * друг от друга (не смешиваться), а старые плоские настройки — переноситься без потерь. Запуск: node test/settings.test.mjs
 */
import assert from "node:assert/strict";
import {
	ASR_ENGINES,
	TTS_ENGINES,
	buildPublicSlots,
	migrateLegacySettings,
	mergeSettings,
	resolveAsrConfig,
	resolveTtsConfig,
	resolveTtsEngine,
	sanitizeSettings
} from "../lib/index.js";

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

// Старые настройки из реальной жалобы: ключи MiMo перекрыло «пользовательским TTS», а голос остался в другом движке
const LEGACY_USER_FILE = {
	asrBaseUrl: "http://127.0.0.1:52625/v1",
	asrModel: "whisper-v3",
	asrApiKey: "flm",
	ttsVoice: "Mia",
	autoSend: false,
	silenceMs: 2000,
	rewrite: true,
	ttsEngine: "edge",
	ttsBaseUrl: "http://127.0.0.1:52992/v1",
	ttsModel: "kokoro-82m-zh",
	ttsApiKey: "sk-custom",
	asrEngine: "custom"
};

console.log("Старые плоские настройки → разложение по слотам движков");
test("Учётные данные ASR попадают в выбранный движок custom", () => {
	const m = migrateLegacySettings(LEGACY_USER_FILE);
	assert.deepEqual(m.asr.custom, {
		baseUrl: "http://127.0.0.1:52625/v1",
		model: "whisper-v3",
		apiKey: "flm"
	});
	assert.equal(m.asr.mimo, undefined);
	assert.equal(m.asr.siliconflow, undefined);
});

test("Локальные ключи TTS — в custom, голос MiMo «Mia» — в mimo (ключевое исправление)", () => {
	const m = migrateLegacySettings(LEGACY_USER_FILE);
	assert.deepEqual(m.tts.custom, {
		baseUrl: "http://127.0.0.1:52992/v1",
		model: "kokoro-82m-zh",
		apiKey: "sk-custom"
	});
	assert.equal(m.tts.mimo.voice, "Mia");
	assert.equal(m.tts.edge, undefined, "Edge не должен засоряться URL/ключом от custom");
});

test("Голос Edge (Neural) попадает в edge и не перекрывается голосом MiMo", () => {
	const m = migrateLegacySettings({ ttsEngine: "edge", ttsVoice: "zh-CN-YunxiNeural", ttsBaseUrl: "https://x/v1", ttsApiKey: "k" });
	assert.equal(m.tts.edge.voice, "zh-CN-YunxiNeural");
	assert.equal(m.tts.custom.apiKey, "k");
});

test("Миграция идемпотентна: повторный перенос уже перенесённой структуры ничего не меняет", () => {
	const once = migrateLegacySettings(LEGACY_USER_FILE);
	const twice = migrateLegacySettings(once);
	assert.deepEqual(twice.tts, once.tts);
	assert.deepEqual(twice.asr, once.asr);
});

test("Конечная точка chat/completions для ASR попадает в mimo", () => {
	const m = migrateLegacySettings({ asrEngine: "siliconflow", asrBaseUrl: "https://api.xiaomimimo.com/v1/chat/completions", asrApiKey: "k" });
	assert.equal(m.asr.mimo.apiKey, "k");
	assert.equal(m.asr.siliconflow, undefined);
});

console.log("\nСмена движка ничего не перекрывает (ядро текущего бага)");
test("Сначала настроили MiMo, потом пользовательский TTS — у каждого своё", () => {
	let saved = {};
	saved = mergeSettings(saved, sanitizeSettings({
		ttsEngine: "mimo",
		tts: { mimo: { baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-tts", apiKey: "mimo-key", voice: "冰糖" } }
	}));
	saved = mergeSettings(saved, sanitizeSettings({
		ttsEngine: "custom",
		tts: { custom: { baseUrl: "http://127.0.0.1:52992/v1", model: "kokoro-82m-zh", apiKey: "custom-key", voice: "Mia" } }
	}));
	assert.equal(saved.ttsEngine, "custom");
	assert.deepEqual(saved.tts.mimo, { baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-tts", apiKey: "mimo-key", voice: "冰糖" });
	assert.deepEqual(saved.tts.custom, { baseUrl: "http://127.0.0.1:52992/v1", model: "kokoro-82m-zh", apiKey: "custom-key", voice: "Mia" });
	// Разрешение конфигурации для каждого движка тоже даёт его собственные значения
	const cfg = {};
	assert.equal(resolveTtsConfig(cfg, saved, "mimo", "zh-CN-XiaoxiaoNeural").apiKey, "mimo-key");
	assert.equal(resolveTtsConfig(cfg, saved, "custom", "zh-CN-XiaoxiaoNeural").apiKey, "custom-key");
	assert.equal(resolveTtsConfig(cfg, saved, "custom", "zh-CN-XiaoxiaoNeural").baseUrl, "http://127.0.0.1:52992/v1");
});

test("Смена ключа MiMo не трогает ни ASR, ни пользовательский TTS", () => {
	let saved = mergeSettings({}, sanitizeSettings({
		asrEngine: "custom",
		asr: { custom: { baseUrl: "http://127.0.0.1:52625/v1", model: "whisper-v3", apiKey: "flm" } },
		tts: { custom: { baseUrl: "http://127.0.0.1:52992/v1", model: "kokoro-82m-zh", apiKey: "custom-key" } }
	}));
	const before = JSON.parse(JSON.stringify(saved));
	saved = mergeSettings(saved, sanitizeSettings({ tts: { mimo: { apiKey: "mimo-key2" } } }));
	assert.equal(saved.tts.mimo.apiKey, "mimo-key2");
	assert.deepEqual(saved.asr, before.asr);
	assert.deepEqual(saved.tts.custom, before.tts.custom);
	// Собственный ключ пользовательского TTS не задет
	assert.equal(resolveTtsConfig({}, saved, "custom", "").apiKey, "custom-key");
});

test("Голоса у трёх движков TTS независимы друг от друга", () => {
	let saved = mergeSettings({}, sanitizeSettings({ tts: { edge: { voice: "zh-CN-YunxiNeural" } } }));
	saved = mergeSettings(saved, sanitizeSettings({ tts: { mimo: { voice: "茉莉" } } }));
	saved = mergeSettings(saved, sanitizeSettings({ tts: { custom: { voice: "Mia" } } }));
	assert.equal(resolveTtsConfig({}, saved, "edge", "zh-CN-XiaoxiaoNeural").voice, "zh-CN-YunxiNeural");
	assert.equal(resolveTtsConfig({}, saved, "mimo", "").voice, "茉莉");
	assert.equal(resolveTtsConfig({}, saved, "custom", "").voice, "Mia");
});

test("Очистка поля одного движка задевает только его самого", () => {
	let saved = mergeSettings({}, sanitizeSettings({
		tts: { mimo: { baseUrl: "https://a", apiKey: "k1" }, custom: { baseUrl: "https://b", apiKey: "k2" } }
	}));
	saved = mergeSettings(saved, sanitizeSettings({ tts: { mimo: { apiKey: "" } } }));
	assert.equal(saved.tts.mimo.apiKey, "");
	assert.equal(saved.tts.custom.apiKey, "k2");
});

console.log("\nСовместимость со старым клиентом (плоские ключи)");
test("Плоские ключи попадают только в слот текущего выбранного движка", () => {
	const saved = mergeSettings({ ttsEngine: "mimo" }, sanitizeSettings({
		ttsEngine: "mimo", ttsBaseUrl: "https://api.xiaomimimo.com/v1", ttsModel: "mimo-v2.5-tts", ttsApiKey: "old-key", ttsVoice: "冰糖"
	}));
	assert.deepEqual(saved.tts.mimo, { baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-tts", apiKey: "old-key", voice: "冰糖" });
	assert.equal(saved.tts.custom, undefined);
});

test("Edge не принимает старые URL/модель/ключ (только голос)", () => {
	const saved = mergeSettings({}, sanitizeSettings({
		ttsEngine: "edge", ttsBaseUrl: "http://127.0.0.1:52992/v1", ttsModel: "kokoro", ttsApiKey: "k", ttsVoice: "zh-CN-XiaoxiaoNeural"
	}));
	assert.deepEqual(saved.tts.edge, { voice: "zh-CN-XiaoxiaoNeural" });
	assert.equal(saved.tts.custom, undefined);
});

test("В сохранённом результате не остаётся старых плоских ключей", () => {
	const saved = mergeSettings(LEGACY_USER_FILE, sanitizeSettings({ silenceMs: 3000 }));
	for (const key of ["asrBaseUrl", "asrModel", "asrApiKey", "ttsBaseUrl", "ttsModel", "ttsApiKey", "ttsVoice"]) {
		assert.equal(key in saved, false, `ключ ${key} должен быть вычищен`);
	}
});

test("Старый клиент, меняющий только паузу тишины, тоже не теряет настройки", () => {
	const saved = mergeSettings(LEGACY_USER_FILE, sanitizeSettings({ silenceMs: 3000 }));
	assert.equal(saved.silenceMs, 3000);
	assert.equal(saved.asr.custom.apiKey, "flm");
	assert.equal(saved.tts.custom.model, "kokoro-82m-zh");
	assert.equal(saved.tts.mimo.voice, "Mia");
});

console.log("\nОтдача слотов / разбор конфигурации");
test("Отдаваемые слоты — по одному на движок, к пропускам подставляются встроенные значения", () => {
	const saved = migrateLegacySettings(LEGACY_USER_FILE);
	const slots = buildPublicSlots({}, saved, "zh-CN-XiaoxiaoNeural");
	assert.equal(slots.tts.edge.voice, "zh-CN-XiaoxiaoNeural");
	assert.equal(slots.tts.mimo.model, "mimo-v2.5-tts");
	assert.equal(slots.tts.custom.model, "kokoro-82m-zh");
	assert.equal(slots.tts.custom.baseUrl, "http://127.0.0.1:52992/v1");
	assert.equal(slots.tts.mimo.baseUrl, "https://api.xiaomimimo.com/v1", "Пустое значение у MiMo должно откатываться к эндпоинту производителя, а не перекрываться URL пользовательского TTS");
	assert.equal(slots.asr.siliconflow.model, "FunAudioLLM/SenseVoiceSmall");
	assert.equal(slots.asr.custom.apiKey, "flm");
});

test("MiMo TTS работает и без заполненного Base URL (встроенный эндпоинт производителя; регрессия: 400 от маршрута озвучки без звука)", () => {
	const saved = mergeSettings({}, sanitizeSettings({ ttsEngine: "mimo", tts: { mimo: { apiKey: "k" } } }));
	const cfg = resolveTtsConfig({}, saved, "mimo", "");
	assert.equal(cfg.baseUrl, "https://api.xiaomimimo.com/v1", "Пустое значение должно откатываться к эндпоинту производителя");
	assert.equal(cfg.model, "mimo-v2.5-tts");
	assert.equal(cfg.apiKey, "k");
	// У пользовательского TTS эндпоинта производителя нет: его всё равно приходится указывать явно, иначе ошибка невнятная
	assert.equal(resolveTtsConfig({}, saved, "custom", "").baseUrl, "");
});

test("Конфиг из строки поддерживает изоляцию по движкам и перекрывается панелью настроек", () => {
	const config = { ttsEngine: "mimo", tts: { mimo: { baseUrl: "https://api.xiaomimimo.com/v1", apiKey: "cfg-key" } } };
	const empty = {};
	assert.equal(resolveTtsConfig(config, empty, "mimo", "").apiKey, "cfg-key");
	assert.equal(resolveTtsConfig(config, empty, "custom", "").baseUrl, "", "Настройки mimo из конфига не должны утекать в custom");
	const saved = mergeSettings({}, sanitizeSettings({ tts: { mimo: { apiKey: "panel-key" } } }));
	assert.equal(resolveTtsConfig(config, saved, "mimo", "").apiKey, "panel-key");
	assert.equal(resolveTtsEngine(config, {}), "mimo");
	assert.equal(resolveTtsEngine(config, { ttsEngine: "custom" }), "custom");
});

test("Старые плоские ключи в конфиге всё ещё работают (применяются к текущему движку)", () => {
	const config = { ttsEngine: "custom", ttsBaseUrl: "https://api.openai.com/v1", ttsApiKey: "sk-flat" };
	assert.equal(resolveTtsConfig(config, {}, "custom", "").baseUrl, "https://api.openai.com/v1");
	assert.equal(resolveTtsConfig(config, {}, "custom", "").apiKey, "sk-flat");
});

test("Недопустимое имя движка и недопустимые поля отбрасываются", () => {
	const saved = mergeSettings({}, sanitizeSettings({ ttsEngine: "gemini", tts: { gemini: { apiKey: "x" }, mimo: { bogus: "y", apiKey: "k" } }, asrEngine: "foo" }));
	assert.equal(saved.ttsEngine, "edge");
	assert.equal(saved.asrEngine, "siliconflow");
	assert.equal(saved.tts.gemini, undefined);
	assert.deepEqual(saved.tts.mimo, { apiKey: "k" });
});

test("Разбор ASR: каждый движок читает только свой слот", () => {
	const saved = mergeSettings({}, sanitizeSettings({
		asrEngine: "custom",
		asr: { custom: { baseUrl: "http://127.0.0.1:52625/v1", model: "whisper-v3", apiKey: "flm" }, groq: { apiKey: "gsk-x" } }
	}));
	assert.equal(resolveAsrConfig({}, saved).engine, "custom");
	assert.equal(resolveAsrConfig({}, saved).apiKey, "flm");
	const groqSaved = { ...saved, asrEngine: "groq" };
	assert.equal(resolveAsrConfig({}, groqSaved).apiKey, "gsk-x");
	assert.equal(resolveAsrConfig({}, groqSaved).baseUrl, "https://api.groq.com/openai/v1");
});

console.log("\nНовые настройки: ratePercent, speechLang, движки browser/local");
test("ratePercent: значение сохраняется", () => {
	const saved = mergeSettings({}, sanitizeSettings({ ratePercent: 150 }));
	assert.equal(saved.ratePercent, 150);
});

test("ratePercent: clamp 50-200", () => {
	assert.equal(sanitizeSettings({ ratePercent: 10 }).ratePercent, 50);
	assert.equal(sanitizeSettings({ ratePercent: 500 }).ratePercent, 200);
	assert.equal(sanitizeSettings({ ratePercent: 110 }).ratePercent, 110);
});

test("speechLang: значение сохраняется", () => {
	const saved = mergeSettings({}, sanitizeSettings({ speechLang: "ru-RU" }));
	assert.equal(saved.speechLang, "ru-RU");
});

test("speechLang: дефолт ru-RU", () => {
	const saved = mergeSettings({}, sanitizeSettings({}));
	assert.equal(saved.speechLang, undefined);
});

test("Движки browser/local принимаются", () => {
	const saved = mergeSettings({}, sanitizeSettings({ ttsEngine: "browser", asrEngine: "local" }));
	assert.equal(saved.ttsEngine, "browser");
	assert.equal(saved.asrEngine, "local");
});

test("Движки browser/local в списке TTS_ENGINES/ASR_ENGINES", () => {
	assert.ok(TTS_ENGINES.includes("browser"));
	assert.ok(TTS_ENGINES.includes("local"));
	assert.ok(ASR_ENGINES.includes("browser"));
	assert.ok(ASR_ENGINES.includes("local"));
});

console.log("\ncontinuousMode");
test("continuousMode: значение сохраняется", () => {
	const saved = mergeSettings({}, sanitizeSettings({ continuousMode: true }));
	assert.equal(saved.continuousMode, true);
});

test("continuousMode: дефолт false", () => {
	const saved = mergeSettings({}, sanitizeSettings({}));
	assert.equal(saved.continuousMode, undefined);
});

test("continuousMode: false явно", () => {
	const saved = mergeSettings({}, sanitizeSettings({ continuousMode: false }));
	assert.equal(saved.continuousMode, false);
});

console.log(`\n${passed} пройдено${process.exitCode ? " (есть падения)" : ""}`);
