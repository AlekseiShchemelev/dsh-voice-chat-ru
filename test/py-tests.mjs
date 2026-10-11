// Запуск Python-тестов с мягким пропуском, если интерпретатора нет.
//
// Раньше `npm test` вызывал `python3 test/*.test.py` напрямую: на машине без
// Python весь прогон падал ещё до тестов Node. Эти тесты проверяют Python-часть,
// и без интерпретатора они просто не применимы — это повод пропустить, а не
// завалить сборку. Путь к интерпретатору можно задать DSH_TEST_PYTHON.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const python = process.env.DSH_TEST_PYTHON || "python3";

const probe = spawnSync(python, ["--version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
	console.log(`skip: ${python} недоступен — Python-тесты пропущены (укажите DSH_TEST_PYTHON)`);
	process.exit(0);
}

const tests = ["py-server-multipart.test.py", "py-piper-compat.test.py"];
for (const test of tests) {
	const result = spawnSync(python, [path.join(dir, test)], { stdio: "inherit" });
	if (result.status !== 0) {
		console.error(`FAIL: ${test} (код ${result.status ?? "signal"})`);
		process.exit(result.status ?? 1);
	}
}

console.log("\nPython-тесты: всё зелёное");
