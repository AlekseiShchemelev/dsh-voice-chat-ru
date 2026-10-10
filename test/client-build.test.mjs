/**
 * Свежесть сборки браузерной половины.
 *
 * lib/client.js — генерируемый артефакт: хост грузит его как
 * window.__ModuleLoader__.load({factory}) и его require() не резолвит
 * относительные импорты, поэтому в рантайме файл обязан остаться один.
 * Исходник при этом разбит на куски в src/client/, и склеивает их
 * scripts/build-client.mjs.
 *
 * Главная опасность такой схемы — разъезд: правка в src/client/, о которой
 * забыли, тянет в рантайм старую версию из lib/client.js, и баг «не
 * воспроизводится, код правильный». Тест падает ровно на этом.
 *
 * Запуск: node test/client-build.test.mjs
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT_PARTS, buildClient } from "../scripts/build-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const SRC_DIR = path.join(ROOT, "src", "client");
const OUT_FILE = path.join(ROOT, "lib", "client.js");

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

console.log("\nСборка браузерной половины");

await test("lib/client.js совпадает с результатом сборки src/client/*", async () => {
	const built = await buildClient();
	const current = await readFile(OUT_FILE, "utf8");
	assert.equal(
		current, built,
		"lib/client.js расходится с исходниками — запустите `npm run build:client`"
	);
});

await test("список кусков совпадает с содержимым src/client", async () => {
	const files = (await readdir(SRC_DIR)).filter((n) => n.endsWith(".js")).sort();
	assert.deepEqual(files, [...CLIENT_PARTS].sort(),
		"в src/client лежат файлы, не перечисленные в CLIENT_PARTS (или наоборот)");
});

await test("сборка идемпотентна (повторный запуск даёт тот же файл)", async () => {
	const [a, b] = [await buildClient(), await buildClient()];
	assert.equal(a, b);
});

await test("куски склеиваются в порядке CLIENT_PARTS, а не по алфавиту", async () => {
	// Порядок значим: куски попадают в общую лексическую область factory,
	// и `const` виден только ниже себя. Перестановка молча сломала бы
	// инициализацию без единой синтаксической ошибки.
	assert.notDeepEqual(CLIENT_PARTS, [...CLIENT_PARTS].sort(),
		"CLIENT_PARTS отсортирован по имени — сборка потеряет осмысленный порядок");
	assert.equal(CLIENT_PARTS[0], "header.js", "первым идёт заголовок модуля");
	assert.equal(CLIENT_PARTS.at(-1), "footer.js", "последним — хвост модуля");
});

await test("собранный файл остаётся единственным модулем хоста", async () => {
	const built = await buildClient();
	assert.match(built, /^window\.__ModuleLoader__\.load\(\{/,
		"артефакт должен начинаться с window.__ModuleLoader__.load");
	assert.match(built, /\n\}\);\n?$/, "артефакт должен закрываться вызовом load");
	assert.equal((built.match(/__ModuleLoader__\.load\(/g) || []).length, 1,
		"в артефакте ровно один вызов загрузчика модулей");
	assert.doesNotMatch(built, /^\s*import\s.+\sfrom\s/m,
		"в артефакте не может быть ESM-импортов: require хоста их не резолвит");
});

await test("каждый кусок самодостаточен по именам границ", async () => {
	// Грубая, но полезная проверка: куски не должны «начинаться с середины»,
	// т.е. перед первым объявлением обязана быть законченная мысль.
	const exceptions = new Set(["header.js", "footer.js"]);
	for (const name of CLIENT_PARTS) {
		if (exceptions.has(name)) continue;
		const text = (await readFile(path.join(SRC_DIR, name), "utf8")).replace(/^\s+/, "");
		assert.ok(text.startsWith("/**") || text.startsWith("//") || text.startsWith("/*"),
			`кусок ${name} начинается не с комментария: возможно, граница прошла мимо объявления`);
	}
});

console.log(`\n${passed} пройдено${process.exitCode ? "（есть падения）" : ""}`);
