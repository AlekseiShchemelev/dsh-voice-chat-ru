/**
 * ESLint (flat config) для dsh-voice-chat.
 *
 * Ловим реальные ошибки (неиспользуемые переменные, необъявленные имена,
 * опасные конструкции), а не вкусовщину: стиль репозитория — табы, длинные
 * строки и плотные JSX-вызовы React.createElement, переучивать их не нужно.
 *
 * Две архитектурные особенности учитаны в конфиге:
 *
 * 1. src/client/*.js — НЕ модули. Это куски одного общего лексического
 *    замыкания factory, склеиваемые scripts/build-client.mjs; объявления из
 *    одного куска использует другой, и ESLint с точки зрения отдельного файла
 *    видит «неиспользуемое» и «неопределённое». Для них выключены
 *    no-unused-vars и no-undef — корректность замыкания проверяют сборка
 *    (assertBundleParses) и тесты паритета/поведения.
 * 2. lib/client.js — генерируемый артефакт (править нельзя, только пересобрать),
 *    header.js/footer.js — половинки обёртки и по отдельности не парсятся.
 *    Все три исключены из линтинга, их синтаксис проверяет scripts/syntax-check.mjs.
 */
import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import globals from "globals";

export default defineConfig([
	// Сгенерированное и не парсящееся по отдельности — мимо линтера
	{ ignores: ["lib/client.js", "src/client/header.js", "src/client/footer.js", "node_modules/", "coverage/"] },
	js.configs.recommended,
	{
		languageOptions: {
			ecmaVersion: 2024,
			sourceType: "module",
			globals: { ...globals.node, ...globals.browser }
		},
		rules: {
			// «catch (err) { /* ignore */ }» — идиома этого репозитория: пустые
			// обработчики допустимы, ошибка глушится осознанно
			"no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
			"no-empty": ["error", { allowEmptyCatch: true }],
			"no-constant-condition": ["error", { checkLoops: false }]
		}
	},
	{
		// Фрагменты общего замыкания (см. шапку)
		files: ["src/client/**/*.js"],
		rules: {
			"no-undef": "off",
			"no-unused-vars": "off"
		}
	}
]);