#!/usr/bin/env node
/**
 * Сборка браузерной половины: src/client/*.js → lib/client.js.
 *
 * ПОЧЕМУ ТАК. Браузерный модуль отдаётся хосту как
 * `window.__ModuleLoader__.load({ factory: (require) => {...} })`, и require()
 * у него умеет только пакеты из графа модулей — относительные импорты вида
 * "./shared.js" там не резолвятся (проверено по dsh-client-modules). То есть
 * файл в рантайме обязан остаться ОДНИМ. Чтобы это не превращало
 * lib/client.js в простыню на 2400 строк, исходник разбит на куски по
 * ответственности, а этот скрипт их склеивает.
 *
 * Куски НЕ модули: они попадают в общую лексическую область factory и
 * видят объявления друг друга (порядок склейки значим). Побочный эффект —
 * сохраняется и есть своя ценность: видно, что состояние, шина настроек и
 * два компонента связаны через общие ссылки, а не через экспорт.
 *
 * Правило: между кусками ровно одна пустая строка. Скрипт идемпотентен —
 * повторный запуск даёт тот же файл, а test/client-build.test.mjs падает,
 * если lib/client.js разошёлся с исходниками.
 *
 * Запуск: node scripts/build-client.mjs [--check]
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC_DIR = path.join(ROOT, "src", "client");
const OUT_FILE = path.join(ROOT, "lib", "client.js");

/**
 * Порядок кусков. Задан явно, а не по алфавиту: куски склеиваются в общую
 * лексическую область, и объявления `const` видны только ниже себя.
 */
export const CLIENT_PARTS = [
	"header.js",
	"01-core.js",
	"02-icons.js",
	"03-styles-voices.js",
	"04-hotkey-browser-asr.js",
	"05-local-engine-box.js",
	"06-settings-bus-and-section.js",
	"07-voice-chat-button.js",
	"08-plugin.js",
	"footer.js"
];

/** Собрать содержимое lib/client.js из кусков. */
export async function buildClient() {
	const available = (await readdir(SRC_DIR)).filter((name) => name.endsWith(".js")).sort();
	const missing = CLIENT_PARTS.filter((name) => !available.includes(name));
	const unknown = available.filter((name) => !CLIENT_PARTS.includes(name));
	if (missing.length || unknown.length) {
		throw new Error([
			`src/client рассинхронизирован со списком сборки.`,
			missing.length ? `нет кусков: ${missing.join(", ")}` : "",
			unknown.length ? `неучтённые файлы: ${unknown.join(", ")}` : ""
		].filter(Boolean).join("; "));
	}
	const chunks = [];
	for (const name of CLIENT_PARTS) {
		chunks.push(await readFile(path.join(SRC_DIR, name), "utf8"));
	}
	return chunks.join("");
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const check = process.argv.includes("--check");
	const built = await buildClient();
	if (check) {
		const current = await readFile(OUT_FILE, "utf8").catch(() => "");
		if (current !== built) {
			console.error("lib/client.js расходится с src/client/*.js — запустите: npm run build:client");
			process.exitCode = 1;
		} else {
			console.log("lib/client.js в актуальном состоянии");
		}
	} else {
		await writeFile(OUT_FILE, built, "utf8");
		console.log(`lib/client.js собран из ${CLIENT_PARTS.length} кусков (${built.length} байт)`);
	}
}
