/**
 * Паритет браузерной половины и общего модуля.
 *
 * lib/client.js подключается хостом как window.__ModuleLoader__.load({factory})
 * и его require() умеет только пакеты из графа модулей — относительные импорты
 * вида "./shared.js" там не резолвятся. Поэтому константы и чистые функции
 * существуют в двух копиях, и они обязаны совпадать.
 *
 * Расхождение здесь стоило пользователю реальных поломок: список моделей
 * faster-whisper и дефолтный порт локального сервера «разъезжались» между
 * файлами, и UI предлагал то, чего сервер не принимает.
 *
 * Запуск: node test/shared-parity.test.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	ASR_ENGINES,
	SOLO_MODIFIER_CODES,
	ASR_ENGINE_DEFAULTS,
	DEFAULT_HOTKEY,
	DEFAULT_LOCAL_PORT,
	LOCAL_ASR_MODELS,
	LOCAL_TTS_VOICES,
	TTS_ENGINES,
	TTS_ENGINE_DEFAULTS,
	normalizeHotkey,
	hotkeyLabel,
	hotkeyFromEvent,
	cleanForTts,
	localPortFromUrl,
	localUrlFromPort
} from "../lib/shared.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_SRC = path.join(HERE, "..", "lib", "client.js");

let passed = 0;
async function test(name, fn) {
	try {
		await fn();
		passed += 1;
		console.log(`  ok  ${name}`);
	} catch (err) {
		console.error(`FAIL  ${name}`);
		console.error(err);
		process.exitCode = 1;
	}
}

/**
 * Достать из исходника клиента объявление по имени. Отступы в клиенте
 * «плавающие» (внутри функций), поэтому ищем по регулярке, а не по префиксу.
 */
function clientDecl(src, name) {
	const objAt = src.search(new RegExp(`\\n\\s*const ${name} = \\{`, "m"));
	if (objAt >= 0) {
		let depth = 0;
		for (let i = src.indexOf("{", objAt); i < src.length; i++) {
			if (src[i] === "{") depth++;
			else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(src.indexOf("{", objAt), i + 1); }
		}
	}
	const arrAt = src.search(new RegExp(`\\n\\s*const ${name} = \\[`, "m"));
	if (arrAt >= 0) {
		const end = src.indexOf("]", arrAt);
		if (end > 0) return src.slice(src.indexOf("[", arrAt), end + 1);
	}
	const setAt = src.search(new RegExp(`\\n\\s*const ${name} = new Set\\(\\[`, "m"));
	if (setAt >= 0) {
		const start = src.indexOf("[", setAt);
		let depth = 0;
		for (let i = start; i < src.length; i++) {
			if (src[i] === "[") depth++;
			else if (src[i] === "]") { depth--; if (depth === 0) return `new Set(${src.slice(start, i + 1)})`; }
		}
	}
	const fnAt = src.search(new RegExp(`\\n\\s*function ${name}\\(`, "m"));
	if (fnAt >= 0) {
		const bodyStart = src.indexOf("{", fnAt);
		let depth = 0;
		for (let i = bodyStart; i < src.length; i++) {
			if (src[i] === "{") depth++;
			else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(fnAt, i + 1); }
		}
	}
	return null;
}

/** Поднять объявление клиента в изоляции (его собственные зависимости передаём явно). */
function clientFn(name, deps = {}) {
	const literal = clientDecl(client.src, name);
	assert.ok(literal, `${name} не найдена в lib/client.js`);
	const body = literal.replace(
		new RegExp(`^\\s*(const|function)\\s+${name}`),
		literal.trimStart().startsWith("function") ? "return function" : "return"
	);
	// eslint-disable-next-line no-new-func
	return new Function(...Object.keys(deps), body)(...Object.values(deps));
}

/** Вычислить объект/массив из литерала клиента. */
function clientValue(name) {
	const literal = clientDecl(client.src, name);
	assert.ok(literal, `${name} должен быть объявлен в lib/client.js`);
	// eslint-disable-next-line no-new-func
	return new Function(`return (${literal});`)();
}

const client = { src: await readFile(CLIENT_SRC, "utf8") };

console.log("\nКонстанты: клиентская копия == lib/shared.js");

for (const name of ["ASR_ENGINE_DEFAULTS", "TTS_ENGINE_DEFAULTS", "LOCAL_ASR_MODELS", "LOCAL_TTS_VOICES"]) {
	await test(name, async () => {
		const literal = clientDecl(client.src, name);
		assert.ok(literal, `${name} должен быть объявлен в lib/client.js`);
		// eslint-disable-next-line no-new-func
		const fromClient = new Function(`return (${literal});`)();
		const fromShared = { ASR_ENGINE_DEFAULTS, TTS_ENGINE_DEFAULTS, LOCAL_ASR_MODELS, LOCAL_TTS_VOICES }[name];
		assert.deepEqual(fromClient, fromShared,
			`${name} разошёлся между lib/client.js и lib/shared.js — поправь обе копии`);
	});
}

await test("ASR_ENGINES / TTS_ENGINES", async () => {
	const asr = new Function(`return (${clientDecl(client.src, "ASR_ENGINES")});`)();
	const tts = new Function(`return (${clientDecl(client.src, "TTS_ENGINES")});`)();
	assert.deepEqual(asr, ASR_ENGINES);
	assert.deepEqual(tts, TTS_ENGINES);
});

await test("DEFAULT_LOCAL_PORT", async () => {
	assert.match(client.src, /const DEFAULT_LOCAL_PORT = 8765;/);
	assert.equal(DEFAULT_LOCAL_PORT, 8765);
});

await test("ASR_ENGINE_LABELS покрывает все движки ASR", async () => {
	const labels = clientValue("ASR_ENGINE_LABELS");
	for (const engine of ASR_ENGINES) {
		assert.ok(labels[engine], `нет подписи для движка ${engine}`);
	}
});

await test("SOLO_MODIFIER_CODES совпадает с серверным", async () => {
	const fromClient = clientValue("SOLO_MODIFIER_CODES");
	const fromServer = [...SOLO_MODIFIER_CODES].sort();
	assert.deepEqual([...fromClient].sort(), fromServer,
		"набор одиночных модификаторов разошёлся — правь обе копии");
});

await test("hotkeyFromEvent даёт ту же каноническую строку, что и сервер", async () => {
	const solo = clientValue("SOLO_MODIFIER_CODES");
	const byLower = new Map([...solo].map((code) => [code.toLowerCase(), code]));
	const canonical = (code, key) => {
		if (solo.has(code)) return code;
		if (byLower.has(String(code).toLowerCase())) return byLower.get(String(code).toLowerCase());
		if (/^Key[A-Z]$/.test(code)) return code.slice(3);
		if (/^Digit\d$/.test(code)) return code.slice(5);
		if (/^Numpad\d$/.test(code)) return "Num" + code.slice(6);
		const raw = String(key ?? "");
		if (raw === " ") return "Space";
		if (raw.length === 1) return raw.toUpperCase();
		return raw || code || "";
	};
	const fromClient = clientFn("hotkeyFromEvent", { SOLO_MODIFIER_CODES: solo, hotkeyKeyName: canonical });
	const events = [
		{ code: "ControlRight", key: "Control", ctrlKey: true },
		{ code: "KeyM", key: "m", ctrlKey: true, shiftKey: true },
		{ code: "Space", key: " " },
		{ code: "Digit1", key: "1" },
		{ code: "Numpad3", key: "3" },
		{ code: "KeyK", key: "k", metaKey: true },
		{ code: "ShiftLeft", key: "Shift", shiftKey: true }
	];
	for (const event of events) {
		assert.equal(fromClient(event), hotkeyFromEvent(event),
			`hotkeyFromEvent(${JSON.stringify(event)}) разошёлся`);
	}
});

await test("hotkeyLabel одинаково подписывает каноническое сочетание", async () => {
	// Сервер принимает «сырое» значение и нормализует сам, клиент — уже канон.
	// Сравниваем на канонических строках, которые сервер отдаёт в /settings.
	const fromClient = clientFn("hotkeyLabel");
	for (const value of ["ControlRight", "ControlLeft", "Ctrl+Shift+Space", "Alt+ArrowUp", "Shift+Ctrl+M", "Meta+K"]) {
		const canonical = normalizeHotkey(value);
		assert.equal(fromClient(canonical), hotkeyLabel(canonical),
			`подпись для ${canonical} разошёлась`);
	}
});

await test("в клиенте нет своей копии cleanForTts (чистка — на сервере)", async () => {
	// Очистка markdown перед синтезом живёт только на сервере: если появится
	// вторая копия в клиенте, начнёт расходиться вывод «что читаем вслух».
	assert.doesNotMatch(client.src, /function cleanForTts/,
		"cleanForTts продублирован в lib/client.js — оставьте одну реализацию в lib/shared.js");
});

await test("localPortFromUrl / localUrlFromPort согласованы с портом по умолчанию", async () => {
	assert.match(client.src, /function localPortFromUrl/);
	assert.match(client.src, /function localUrlFromPort/);
	assert.equal(localUrlFromPort(String(DEFAULT_LOCAL_PORT)), "", "дефолтный порт → пустой адрес");
	assert.equal(localUrlFromPort("41234"), "http://127.0.0.1:41234/v1");
	assert.equal(localPortFromUrl("http://127.0.0.1:41234/v1"), "41234");
	assert.equal(localPortFromUrl(localUrlFromPort("41234")), "41234", "порт и адрес обратимы");
	assert.equal(localPortFromUrl(""), String(DEFAULT_LOCAL_PORT), "пустой адрес → дефолтный порт");
});

await test("DEFAULT_HOTKEY совпадает", async () => {
	assert.match(client.src, new RegExp(`DEFAULT_HOTKEY = "${DEFAULT_HOTKEY}"`));
});

console.log(`\n${passed} пройдено${process.exitCode ? "（есть падения）" : ""}`);
