		// ---------- Плоские SVG-иконки (стиль Feather, линейная обводка, цвет из currentColor) ----------
		const ICON_MIC = [
			"M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z",
			"M19 10v2a7 7 0 0 1-14 0v-2",
			"M12 19v4",
			"M8 23h8"
		];
		const ICON_SPEAKER = [
			"M11 5L6 9H2v6h4l5 4V5z",
			"M15.54 8.46a5 5 0 0 1 0 7.07",
			"M19.07 4.93a10 10 0 0 1 0 14.14"
		];
		const ICON_MUTED = [
			"M11 5L6 9H2v6h4l5 4V5z",
			"M23 9l-6 6",
			"M17 9l6 6"
		];
				/** Рисует линейную SVG-иконку 24x24. */
		function Icon({ paths, size = 16 }) {
			return React.createElement("svg", {
				viewBox: "0 0 24 24",
				width: size,
				height: size,
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 2,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": true
			}, paths.map((d, i) => React.createElement("path", { key: i, d })));
		}

