#!/usr/bin/env node
/**
 * Синтаксическая проверка всех JS-файлов репозитория и собранного бандла клиента.
 *
 * Зачем: собранной `lib/client.js` в `git diff` не видно оборота, а тесты падают
 * уже на импорте — одно «не закрыл скобку» превращается в непонятный failed test
 * вместо мгновенного «синтаксическая ошибка в таком-то файле». Ещё один случай:
 * правка в `src/client/`, забытая пересборка → рантайм молча берёт старый бандл.
 * Этот скрипт гоняет `node --check` по каждому файлу и заодно проверяет, что
 * бандл собирается и парсится (то есть исходники клиента не разъехались).
 *
 * Фрагменты `header.js`/`footer.js` сами по себе не являются валидным script
 * (это половинки обёртки), поэтому их синтаксис проверяется опосредованно —
 * собранным бандлом.
 *
 * Запуск: node scripts/syntax-check.mjs
 */
import { spawnSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildClient } from "./build-client.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SKIP = new Set(["header.js", "footer.js", "client.js"]);
const DIRS = ["lib", "src/client", "scripts", "test"];

let failed = 0;
let checked = 0;

/** Рекурсивный обход каталога в поисках .js/.mjs/.cjs файлов. */
async function* walkJs(dir) {
	for (const entry of await readdir(dir)) {
		const full = path.join(dir, entry);
		const meta = await stat(full).catch(() => null);
		if (!meta) continue;
		if (meta.isDirectory()) yield* walkJs(full);
		else if (/\.(js|mjs|cjs)$/.test(entry)) yield full;
	}
}

function check(file) {
	const rel = path.relative(ROOT, file);
	if (SKIP.has(path.basename(file))) return;
	checked += 1;
	const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
	if (result.status !== 0) {
		failed += 1;
		console.error(`✗ ${rel}`);
		console.error(result.stderr || result.stdout || "неизвестная синтаксическая ошибка");
	} else {
		console.log(`  ok ${rel}`);
	}
}

for (const dir of DIRS) {
	for await (const file of walkJs(path.join(ROOT, dir))) check(file);
}

// Собранный бандл: исходники клиента собираются и парсится как script.
// Файл кладём во временный каталог: lib/client.js мог расходиться (хост уже
// может тащить старую версию), а нам нужна проверка именно текущих исходников.
const built = await buildClient();
const tmp = path.join(process.env.TMPDIR || process.env.TMP || "/tmp", `dsh-vc-syntax-${process.pid}.js`);
const { writeFile, rm } = await import("node:fs/promises");
await writeFile(tmp, built, "utf8");
checked += 1;
const result = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
if (result.status !== 0) {
	failed += 1;
	console.error(`✗ собранный бандл клиента (${tmp})`);
	console.error(result.stderr || result.stdout || "синтаксическая ошибка в бандле");
} else {
	console.log(`  ok собранный бандл клиента (${(built.length / 1024) | 0} КБ)`);
}
await rm(tmp, { force: true });

console.log(`\nСинтаксис: ${checked} файлов проверено${failed ? `, ПАДЕНИЙ: ${failed}` : ", всё чисто"}`);
if (failed) process.exit(1);