window.__ModuleLoader__.load({
	id: "dsh-voice-chat",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let React = require("react");
		const { useState, useEffect, useRef, useCallback } = React;

