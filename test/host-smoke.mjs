/**
 * Сквозной дымовой тест маршрутов хоста: по-настоящему проходим /settings,
 * зарегистрированный через apply() (GET отдаёт слоты по движкам, POST сохраняет только слот текущего движка,
 * Настройки пишутся во временный файл (DSH_VOICE_SETTINGS_FILE) — боевой
 * settings.local.json не трогаем.
 * Запуск: node test/host-smoke.mjs
 */
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_DIR = await mkdtemp(path.join(os.tmpdir(), "dsh-vc-smoke-"));
const SETTINGS_FILE = path.join(SETTINGS_DIR, "settings.local.json");
process.env.DSH_VOICE_SETTINGS_FILE = SETTINGS_FILE;
const { apply } = await import("../lib/index.js");

const pkgVersion = JSON.parse(await readFile(path.join(HERE, "..", "package.json"), "utf8")).version;

let passed = 0;
function check(name, fn) {
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

/** Фальшивый res: собирает код статуса и JSON-тело. */
function fakeRes() {
	const captured = {};
	return {
		captured,
		writeHead(status, headers) { captured.status = status; captured.headers = headers; },
		end(body) { captured.body = body; }
	};
}
/** Фальшивый req: GET или POST (тело — строкой). */
function fakeReq(method, url, body) {
	const req = { method, url };
	if (body !== undefined) {
		req[Symbol.asyncIterator] = async function* () {
			yield Buffer.from(body, "utf8");
		};
	}
	return req;
}

const routes = new Map();
const httpCtx = {
	webServer: {
		register(entry) {
			routes.set(entry.path, entry.handler);
			return () => routes.delete(entry.path);
		}
	},
	effect(fn) { return fn(); },
	get() { return undefined; },
	llm: { stream() { throw new Error("not used in smoke test"); } },
	sessions: {}
};
const ctx = {
	inject(deps, fn) { fn(httpCtx); }
};

apply(ctx, {}); // конфиг строки не передаём, всё идёт по цепочке значений по умолчанию + settings.local.json
assert.ok(routes.has("/dsh-voice-chat/settings"), "маршрут /settings должен быть зарегистрирован");
assert.ok(routes.has("/dsh-voice-chat/stt"), "маршрут /stt должен быть зарегистрирован");
assert.ok(routes.has("/dsh-voice-chat/tts"), "маршрут /tts должен быть зарегистрирован");
assert.ok(routes.has("/dsh-voice-chat/speak"), "маршрут /speak должен быть зарегистрирован");

async function getSettings() {
	const res = fakeRes();
	await routes.get("/dsh-voice-chat/settings")(fakeReq("GET", "/dsh-voice-chat/settings"), res);
	assert.equal(res.captured.status, 200, "GET /settings должен вернуть 200");
	return JSON.parse(res.captured.body);
}
async function postSettings(payload) {
	const res = fakeRes();
	await routes.get("/dsh-voice-chat/settings")(
		fakeReq("POST", "/dsh-voice-chat/settings", JSON.stringify(payload)), res
	);
	assert.equal(res.captured.status, 200, "POST /settings должен вернуть 200");
	return JSON.parse(res.captured.body);
}

try {
	console.log("GET /settings (отдача слотов по движкам)");
	const first = await getSettings();
	check("С version, выбором движка и глобальными полями", () => {
		assert.equal(first.version, pkgVersion);
		assert.ok(["edge", "mimo", "custom"].includes(first.ttsEngine));
		assert.ok(first.asrConfig && first.ttsConfig, "asrConfig/ttsConfig должны возвращаться");
	});
	check("В ttsConfig по экземпляру на каждый из трёх движков, поля на месте", () => {
		for (const engine of ["edge", "mimo", "custom"]) {
			assert.ok(first.ttsConfig[engine], `ttsConfig.${engine} должен существовать`);
			assert.ok("voice" in first.ttsConfig[engine]);
		}
		assert.equal(first.ttsConfig.mimo.model, "mimo-v2.5-tts");
		assert.equal(first.ttsConfig.custom.model, "tts-1");
		assert.equal(first.ttsConfig.custom.voice, "alloy");
		assert.equal(first.ttsConfig.edge.voice.length > 0, true, "Голос Edge должен откатываться к встроенному значению по умолчанию");
	});
	check("В asrConfig по экземпляру на каждый из четырёх движков", () => {
		for (const engine of ["siliconflow", "groq", "mimo", "custom"]) {
			assert.ok(first.asrConfig[engine], `asrConfig.${engine} должен существовать`);
		}
		assert.equal(first.asrConfig.siliconflow.model, "FunAudioLLM/SenseVoiceSmall");
	});

	console.log("\nPOST /settings (меняется только слот текущего движка)");
	await postSettings({
		asrEngine: "custom",
		asr: { custom: { baseUrl: "http://127.0.0.1:1/v1", model: "m", apiKey: "asr-key" } },
		ttsEngine: "mimo",
		tts: { mimo: { baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-tts", apiKey: "mimo-key", voice: "冰糖" } },
		silenceMs: 2000,
		rewrite: true
	});
	const second = await getSettings();
	check("Слот MiMo TTS успешно записан", () => {
		assert.equal(second.ttsConfig.mimo.apiKey, "mimo-key");
		assert.equal(second.ttsConfig.mimo.voice, "冰糖");
	});
	check("После смены движка сохранение в custom не перекрывает MiMo", () => {
		assert.equal(second.ttsConfig.mimo.apiKey, "mimo-key");
	});
	await postSettings({
		asrEngine: "custom",
		ttsEngine: "custom",
		tts: { custom: { baseUrl: "http://127.0.0.1:52992/v1", model: "kokoro-82m-zh", apiKey: "custom-key", voice: "Mia" } }
	});
	const third = await getSettings();
	check("Пользовательский TTS и MiMo TTS не перекрывают друг друга", () => {
		assert.equal(third.ttsConfig.custom.apiKey, "custom-key");
		assert.equal(third.ttsConfig.custom.voice, "Mia");
		assert.equal(third.ttsConfig.mimo.apiKey, "mimo-key", "Ключ MiMo должен сохраниться без изменений");
		assert.equal(third.ttsConfig.mimo.voice, "冰糖", "Голос MiMo должен сохраниться без изменений");
		assert.equal(third.ttsConfig.edge.voice, first.ttsConfig.edge.voice, "Голос Edge не задет");
	});
	const onDisk = JSON.parse(await readFile(SETTINGS_FILE, "utf8"));
	check("В записанном файле только слоты asr/tts, старых плоских ключей нет", () => {
		assert.ok(onDisk.asr && onDisk.tts);
		for (const key of ["asrBaseUrl", "asrModel", "asrApiKey", "ttsBaseUrl", "ttsModel", "ttsApiKey", "ttsVoice"]) {
			assert.equal(key in onDisk, false, `ключ ${key} должен быть вычищен`);
		}
		assert.equal(onDisk.tts.mimo.apiKey, "mimo-key");
		assert.equal(onDisk.tts.custom.apiKey, "custom-key");
	});
	await postSettings({
		ttsEngine: "mimo", ttsVoice: "茉莉", ttsBaseUrl: "https://api.xiaomimimo.com/v1", ttsModel: "mimo-v2.5-tts", ttsApiKey: "legacy-key"
	});
	const fourth = await getSettings();
	check("Плоские ключи старого клиента попадают только в текущий движок (MiMo) и не трогают пользовательский TTS", () => {
		assert.equal(fourth.ttsConfig.mimo.apiKey, "legacy-key");
		assert.equal(fourth.ttsConfig.mimo.voice, "茉莉");
		assert.equal(fourth.ttsConfig.custom.apiKey, "custom-key", "Пользовательский TTS должен остаться прежним");
	});

	console.log("\nРегрессия: MiMo TTS без Base URL больше не жалуется «не задан Base URL» (офлайн-проверка)");
	// Убираем ключ MiMo (офлайн это контролируемо): теперь жаловаться должно на «не задан API Key», значит адрес уже откатился к эндпоинту производителя
	await postSettings({ ttsEngine: "mimo", tts: { mimo: { baseUrl: "", apiKey: "" } } });
	const failRes = fakeRes();
	await routes.get("/dsh-voice-chat/tts")(
		fakeReq("GET", "/dsh-voice-chat/tts?text=" + encodeURIComponent("тест")), failRes
	);
	check("При пустом адресе ошибка указывает на ключ, а не на адрес", () => {
		assert.equal(failRes.captured.status, 400);
		const err = JSON.parse(String(failRes.captured.body)).error;
		assert.match(err, /API Key/, `ошибка должна упоминать ключ: ${err}`);
		assert.doesNotMatch(err, /Base URL/, "не должен падать из-за пустого Base URL");
	});
} finally {
	await rm(SETTINGS_DIR, { recursive: true, force: true });
}

console.log(`\n${passed} пройдено${process.exitCode ? " (есть падения)" : ""} (настройки — во временном файле)`);
