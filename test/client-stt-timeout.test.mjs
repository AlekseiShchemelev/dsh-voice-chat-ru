/**
 * Регрессии «микрофон жёлтый и ничего не происходит» — на стороне браузера.
 *
 * Долгое распознавание само по себе не баг: локальный движок в первый раз
 * читает модель с диска. Но пользователь обязан видеть, что ожидание идёт,
 * и иметь выход, если ответа не будет. Здесь закреплены обе гарантии.
 *
 * Запуск: node test/client-stt-timeout.test.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_SRC = path.join(HERE, "..", "lib", "client.js");
const src = await readFile(CLIENT_SRC, "utf8");

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

console.log("\nРаспознавание: обратная связь и таймаут вместо «зависшего» микрофона");

await test("запрос /stt отправляется с сиглом отмены", async () => {
	assert.match(src, /signal: sttController \? sttController\.signal : undefined/,
		"fetch /stt должен принимать signal — иначе отменять запрос нечем");
	assert.match(src, /new AbortController\(\)/);
});

await test("по истечении таймаута запрос отменяется", async () => {
	assert.match(src, /setTimeout\(\(\) => sttController\.abort\(\), STT_TIMEOUT_MS\)/,
		"нужен таймаут, отменяющий висящий запрос");
	assert.match(src, /const STT_TIMEOUT_MS = \d+;/);
	const timeout = Number(/const STT_TIMEOUT_MS = (\d+);/.exec(src)[1]);
	assert.ok(timeout >= 60_000, "таймаут слишком короткий: первый запуск читает модель с диска");
	assert.ok(timeout <= 180_000, "таймаут слишком длинный: пользователь не будет ждать");
});

await test("таймеры гасятся в finally, иначе они копятся при каждой записи", async () => {
	// Границы блока ищем относительно начала, иначе первый же «rec.onerror»
	// в файле (он встречается раньше) сделает срез пустым
	const from = src.indexOf("const sttStartedAt");
	const block = src.slice(from, src.indexOf("rec.onerror", from));
	assert.match(block, /finally \{[\s\S]*clearInterval\(elapsed\)/,
		"секундомер должен гаситься в finally");
	assert.match(block, /if \(sttTimeout\) clearTimeout\(sttTimeout\)/,
		"таймаут отмены должен гаситься в finally");
});

await test("пока идёт ожидание, виден отсчёт секунд", async () => {
	assert.match(src, /setInterval\(\(\) => \{[\s\S]{0,400}?setHint\(/,
		"нужен секундомер, показывающий, что ожидание идёт");
	assert.match(src, /`Распознавание… \$\{secs\} с`/,
		"в подсказке должен быть отсчёт секунд");
	assert.match(src, /локальный движок загружает модель в первый раз/,
		"при долгом ожидании нужно сказать, что именно происходит");
});

await test("обрыв по таймауту объясняет, что делать, а не «ошибка сети»", async () => {
	assert.match(src, /err && err\.name === "AbortError"/);
	assert.match(src, /Настройки DSH → голосовой чат → «Локальный»/,
		"при отмене по таймауту нужна подсказка, куда идти");
});

await test("нет AbortController — запрос уходит без таймаута, но без ошибки", async () => {
	assert.match(src, /typeof AbortController === "function"/,
		"нужна защита для сборок Chromium без AbortController");
	assert.match(src, /const sttController = canAbort \? new AbortController\(\) : null;/);
});

await test("состояние «занято» снимается в любом случае", async () => {
	// Границы блока ищем относительно начала, иначе первый же «rec.onerror»
	// в файле (он встречается раньше) сделает срез пустым
	const from = src.indexOf("const sttStartedAt");
	const block = src.slice(from, src.indexOf("rec.onerror", from));
	assert.match(block, /finally \{[\s\S]*setBusy\(false\)/,
		"иначе микрофон навсегда остаётся жёлтым после любой ошибки");
});

console.log(`\n${passed} пройдено${process.exitCode ? "（есть падения）" : ""}`);
