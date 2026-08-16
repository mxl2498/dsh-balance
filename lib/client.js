/**
 * dsh-balance, 浏览器端：悬浮余额球 + 宿主设置页。
 *
 * - 悬浮胶囊显示 DeepSeek 账户总余额；可拖动（位置记忆在 localStorage）；
 * - 点击展开明细卡片：总余额 / 充值余额 / 赠送余额、更新时间、刷新与去充值按钮；
 * - 余额低于阈值时胶囊变红告警；"去充值"跳转官网充值页；
 * - 自动轮询服务端代理 /dsh-balance/balance（密钥不进入浏览器）；
 * - 在宿主“设置”对话框注册“余额悬浮球”页：总开关、刷新间隔、低余额阈值、悬浮位置；
 * - 设置持久化在 localStorage（`dsh-balance:settings`），同文档 CustomEvent 广播，
 *   悬浮球实时响应开关与参数变化。
 *
 * 加载形态遵循 dsh-client-modules 的 lazy CJS 约定（window.__ModuleLoader__.load），
 * React 通过 require("react") 从 shell 的静态注册表解析。
 */
window.__ModuleLoader__.load({
	id: "@dsh-external/余额悬浮球",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		// ------------------------------------------------------------------
		// 配置默认值（patch config 合并进来）
		// ------------------------------------------------------------------
		const DEFAULTS = {
			enabled: true,
			refreshSeconds: 60,
			lowBalanceThreshold: 5,
			position: "bottom-right",
		};
		let patchDefaults = { ...DEFAULTS };

		// ------------------------------------------------------------------
		// 设置持久化（localStorage + 同文档广播）
		// ------------------------------------------------------------------
		const SETTINGS_KEY = "dsh-balance:settings";
		const CHANGED_EVENT = "dsh-balance:settings-changed";
		let memorySettings = null;

		function readSettings() {
			const base = { ...DEFAULTS, ...patchDefaults };
			if (memorySettings) return { ...base, ...memorySettings };
			try {
				const raw = localStorage.getItem(SETTINGS_KEY);
				if (raw) return { ...base, ...JSON.parse(raw) };
			} catch { /* ignore */ }
			return base;
		}

		function writeSettings(patch) {
			memorySettings = { ...(memorySettings || {}), ...patch };
			try {
				localStorage.setItem(SETTINGS_KEY, JSON.stringify(memorySettings));
			} catch { /* ignore */ }
			dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: memorySettings }));
		}

		function subscribeSettings(fn) {
			const handler = (e) => fn(e.detail);
			addEventListener(CHANGED_EVENT, handler);
			return () => removeEventListener(CHANGED_EVENT, handler);
		}

		// ------------------------------------------------------------------
		// 悬浮球
		// ------------------------------------------------------------------
		/** 服务端代理路由。 */
		const BALANCE_ROUTE = "/dsh-balance/balance";
		/** 兜底充值页地址（服务端响应会带权威值）。 */
		const FALLBACK_TOP_UP_URL = "https://platform.deepseek.com/top_up";
		/** 悬浮层 z-index（置于所有 UI 之上）。 */
		const Z_INDEX = 2147483000;
		/** 拖动位置记忆键。 */
		const POS_KEY = "dsh-balance-pos";

		function formatCNY(v) {
			const n = Number(v);
			if (!Number.isFinite(n)) return "--";
			return "¥" + n.toFixed(2);
		}

		function formatTime(ts) {
			if (!ts) return "";
			const d = new Date(ts);
			const pad = (x) => String(x).padStart(2, "0");
			return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
		}

		const BTN_CSS = [
			"flex:1",
			"padding:6px 0",
			"border-radius:6px",
			"border:1px solid rgba(255,255,255,0.14)",
			"color:#e8eaf0",
			"font-size:12px",
			"font-family:inherit",
			"cursor:pointer",
		].join(";");

		function style(el, css) {
			el.style.cssText = css;
		}

		/**
		 * 悬浮球部件：start/stop/applySettings。
		 * @param {() => object} getSettings - 读取当前设置。
		 */
		function createWidget(getSettings) {
			let root = null;
			let pill = null;
			let card = null;
			let rowsEl = null;
			let refreshBtn = null;
			let topupBtn = null;
			let timer = null;
			let cardOpen = false;
			let started = false;
			let state = {
				status: "loading",
				total: null,
				infos: [],
				fetchedAt: null,
				topUpUrl: FALLBACK_TOP_UP_URL,
				message: "",
			};
			// 拖动状态
			let dragging = false;
			let moved = false;
			let startX = 0;
			let startY = 0;
			let startLeft = 0;
			let startTop = 0;

			function buildDom() {
				root = document.createElement("div");
				style(root, [
					"position:fixed",
					"z-index:" + Z_INDEX,
					"font-family:system-ui,-apple-system,'Segoe UI',sans-serif",
					"user-select:none",
					"-webkit-user-select:none",
					"cursor:pointer",
					"line-height:1.4",
				].join(";"));

				pill = document.createElement("button");
				pill.type = "button";
				style(pill, [
					"display:flex",
					"align-items:center",
					"gap:6px",
					"padding:7px 14px",
					"border-radius:999px",
					"border:1px solid rgba(255,255,255,0.16)",
					"background:rgba(24,26,32,0.88)",
					"color:#e8eaf0",
					"font-size:12px",
					"font-weight:600",
					"font-family:inherit",
					"cursor:pointer",
					"box-shadow:0 4px 16px rgba(0,0,0,0.25)",
					"backdrop-filter:blur(8px)",
					"transition:background .15s ease",
				].join(";"));

				card = document.createElement("div");
				style(card, [
					"position:absolute",
					"right:0",
					"bottom:calc(100% + 8px)",
					"min-width:200px",
					"padding:12px",
					"border-radius:10px",
					"background:rgba(24,26,32,0.96)",
					"border:1px solid rgba(255,255,255,0.14)",
					"box-shadow:0 8px 24px rgba(0,0,0,0.35)",
					"color:#e8eaf0",
					"font-size:12px",
					"display:none",
				].join(";"));

				rowsEl = document.createElement("div");
				rowsEl.style.cssText = "display:flex;flex-direction:column;gap:4px;margin-bottom:10px;";

				refreshBtn = document.createElement("button");
				refreshBtn.type = "button";
				refreshBtn.textContent = "↻ 刷新";
				style(refreshBtn, BTN_CSS + ";background:rgba(255,255,255,0.08)");

				topupBtn = document.createElement("button");
				topupBtn.type = "button";
				topupBtn.textContent = "去充值 ↗";
				style(topupBtn, BTN_CSS + ";background:rgba(77,140,255,0.22);color:#9ec4ff");

				const btnRow = document.createElement("div");
				btnRow.style.cssText = "display:flex;gap:8px;";
				btnRow.appendChild(refreshBtn);
				btnRow.appendChild(topupBtn);

				card.appendChild(rowsEl);
				card.appendChild(btnRow);
				root.appendChild(card);
				root.appendChild(pill);
				document.body.appendChild(root);
				bindInteractions();
			}

			function destroyDom() {
				unbindInteractions();
				if (root && root.parentNode) root.parentNode.removeChild(root);
				root = null;
				pill = null;
				card = null;
				rowsEl = null;
				refreshBtn = null;
				topupBtn = null;
			}

			function lowBalance() {
				const n = Number(state.total);
				return Number.isFinite(n) && n < getSettings().lowBalanceThreshold;
			}

			function render() {
				if (!pill) return;
				const s = state;
				let text, bg, fg, warn = "";
				if (s.status === "loading") {
					text = "余额 …";
					bg = "rgba(24,26,32,0.88)";
					fg = "#9aa0ad";
				} else if (s.status === "error") {
					text = "余额 --";
					bg = "rgba(24,26,32,0.88)";
					fg = "#9aa0ad";
				} else {
					text = "余额 " + formatCNY(s.total);
					fg = "#e8eaf0";
					if (lowBalance()) {
						warn = "⚠ ";
						bg = "rgba(176,44,44,0.92)";
					} else {
						bg = "rgba(24,26,32,0.88)";
					}
				}
				pill.textContent = warn + text;
				pill.style.background = bg;
				pill.style.color = fg;
				const tip = [];
				if (s.status === "ok") {
					tip.push("总余额 " + formatCNY(s.total));
					for (const info of s.infos) {
						if (info.topped_up_balance) tip.push("充值余额 " + formatCNY(info.topped_up_balance));
						if (info.granted_balance) tip.push("赠送余额 " + formatCNY(info.granted_balance));
					}
					if (s.fetchedAt) tip.push("更新于 " + formatTime(s.fetchedAt));
					if (lowBalance()) tip.push("余额不足，点击充值");
				} else if (s.status === "error") {
					tip.push("余额获取失败：" + (s.message || "未知错误"));
				}
				pill.title = tip.join("\n");
			}

			function renderCard() {
				if (!rowsEl) return;
				rowsEl.textContent = "";
				const s = state;
				function row(label, value) {
					const r = document.createElement("div");
					r.style.cssText = "display:flex;justify-content:space-between;gap:12px;";
					const l = document.createElement("span");
					l.textContent = label;
					l.style.color = "#9aa0ad";
					const v = document.createElement("span");
					v.textContent = value;
					v.style.color = "#e8eaf0";
					r.appendChild(l);
					r.appendChild(v);
					return r;
				}
				if (s.status === "ok") {
					for (const info of s.infos) {
						const cur = info.currency || "CNY";
						rowsEl.appendChild(row("总余额（" + cur + "）", formatCNY(info.total_balance)));
						if (info.topped_up_balance != null) rowsEl.appendChild(row("充值余额", formatCNY(info.topped_up_balance)));
						if (info.granted_balance != null) rowsEl.appendChild(row("赠送余额", formatCNY(info.granted_balance)));
					}
					if (s.fetchedAt) rowsEl.appendChild(row("更新时间", formatTime(s.fetchedAt)));
					if (!s.infos.length) {
						const empty = document.createElement("div");
						empty.textContent = "暂无余额信息";
						empty.style.color = "#9aa0ad";
						rowsEl.appendChild(empty);
					}
				} else if (s.status === "error") {
					const err = document.createElement("div");
					err.textContent = "获取失败：" + (s.message || "未知错误");
					err.style.color = "#f0a0a0";
					err.style.whiteSpace = "pre-wrap";
					rowsEl.appendChild(err);
				} else {
					const ld = document.createElement("div");
					ld.textContent = "加载中…";
					ld.style.color = "#9aa0ad";
					rowsEl.appendChild(ld);
				}
			}

			async function refresh() {
				try {
					const res = await fetch(BALANCE_ROUTE, { cache: "no-store" });
					const body = await res.json();
					if (body && body.ok && body.data) {
						const infos = Array.isArray(body.data.balance_infos) ? body.data.balance_infos : [];
						const total = infos.length ? infos[0].total_balance : null;
						state = {
							status: "ok",
							total,
							infos,
							fetchedAt: body.fetchedAt || Date.now(),
							topUpUrl: body.topUpUrl || FALLBACK_TOP_UP_URL,
							message: "",
						};
					} else {
						state = {
							status: "error",
							total: null,
							infos: [],
							fetchedAt: null,
							topUpUrl: FALLBACK_TOP_UP_URL,
							message: (body && body.message) || "服务端返回异常",
						};
					}
				} catch (err) {
					state = {
						status: "error",
						total: null,
						infos: [],
						fetchedAt: null,
						topUpUrl: FALLBACK_TOP_UP_URL,
						message: String((err && err.message) || err),
					};
				}
				render();
				renderCard();
			}

			function startTimer() {
				stopTimer();
				const secs = Math.max(10, Number(getSettings().refreshSeconds) || 60);
				timer = setInterval(() => {
					if (document.hidden) return;
					refresh();
				}, secs * 1000);
			}

			function stopTimer() {
				if (timer) {
					clearInterval(timer);
					timer = null;
				}
			}

			function openCard() {
				cardOpen = true;
				card.style.display = "block";
				renderCard();
			}
			function closeCard() {
				cardOpen = false;
				card.style.display = "none";
			}
			function toggleCard() {
				cardOpen ? closeCard() : openCard();
			}

			function applyPosition(pos) {
				// 拖动记忆优先
				let saved = null;
				try {
					saved = JSON.parse(localStorage.getItem(POS_KEY) || "null");
				} catch { /* ignore */ }
				if (saved && typeof saved.left === "number" && typeof saved.top === "number") {
					root.style.left = saved.left + "px";
					root.style.top = saved.top + "px";
					root.style.right = "auto";
					root.style.bottom = "auto";
					return;
				}
				root.style.left = "auto";
				root.style.top = "auto";
				root.style.right = pos.includes("right") ? "24px" : "auto";
				root.style.left = pos.includes("left") ? "24px" : "auto";
				root.style.bottom = pos.includes("bottom") ? "24px" : "auto";
				root.style.top = pos.includes("top") ? "24px" : "auto";
			}

			// ---- 交互 ----
			function onDown(e) {
				if (e.button !== 0) return;
				dragging = true;
				moved = false;
				startX = e.clientX;
				startY = e.clientY;
				const r = root.getBoundingClientRect();
				startLeft = r.left;
				startTop = r.top;
				e.preventDefault();
			}
			function onMove(e) {
				if (!dragging) return;
				const dx = e.clientX - startX;
				const dy = e.clientY - startY;
				if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
				if (moved) {
					root.style.left = startLeft + dx + "px";
					root.style.top = startTop + dy + "px";
					root.style.right = "auto";
					root.style.bottom = "auto";
				}
			}
			function onUp(e) {
				if (!dragging) return;
				dragging = false;
				const dx = e.clientX - startX;
				const dy = e.clientY - startY;
				if (!moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) {
					toggleCard();
				} else {
					const r = root.getBoundingClientRect();
					try {
						localStorage.setItem(POS_KEY, JSON.stringify({ left: r.left, top: r.top }));
					} catch { /* ignore */ }
					closeCard();
				}
			}
			function onOutside(e) {
				if (!cardOpen) return;
				if (root && root.contains(e.target)) return;
				closeCard();
			}
			function onRefresh(e) {
				e.stopPropagation();
				refresh();
			}
			function onTopup(e) {
				e.stopPropagation();
				window.open(state.topUpUrl || FALLBACK_TOP_UP_URL, "_blank", "noopener");
			}

			function bindInteractions() {
				pill.addEventListener("mousedown", onDown);
				document.addEventListener("mousemove", onMove);
				document.addEventListener("mouseup", onUp);
				document.addEventListener("pointerdown", onOutside);
				refreshBtn.addEventListener("click", onRefresh);
				topupBtn.addEventListener("click", onTopup);
			}
			function unbindInteractions() {
				if (!pill) return;
				pill.removeEventListener("mousedown", onDown);
				document.removeEventListener("mousemove", onMove);
				document.removeEventListener("mouseup", onUp);
				document.removeEventListener("pointerdown", onOutside);
				refreshBtn.removeEventListener("click", onRefresh);
				topupBtn.removeEventListener("click", onTopup);
			}

			return {
				start() {
					if (started) return;
					started = true;
					buildDom();
					applyPosition(getSettings().position);
					startTimer();
					render();
					refresh();
				},
				stop() {
					if (!started) return;
					started = false;
					stopTimer();
					destroyDom();
				},
				applySettings() {
					if (!started) return;
					applyPosition(getSettings().position);
					startTimer();
					render();
				},
			};
		}

		// ------------------------------------------------------------------
		// 设置页（宿主设置对话框中的“余额悬浮球”页）
		// ------------------------------------------------------------------
		const rowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24, padding: "14px 0", borderTop: "1px solid rgba(128,128,128,0.22)" };
		const labelStyle = { fontSize: 15, lineHeight: 1.4 };
		const blurbStyle = { fontSize: 13, lineHeight: 1.5, opacity: 0.55, marginTop: 2 };
		const sourceStyle = { marginBottom: 14, padding: "10px 12px", borderRadius: 8, background: "rgba(128,128,128,0.12)", fontSize: 13, lineHeight: 1.6, opacity: 0.8 };
		const inputStyle = { width: 90, padding: "5px 8px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.4)", background: "rgba(128,128,128,0.12)", color: "inherit", fontSize: 13, fontFamily: "inherit" };

		const POSITIONS = [
			{ value: "bottom-right", label: "右下角" },
			{ value: "top-right", label: "右上角" },
			{ value: "bottom-left", label: "左下角" },
			{ value: "top-left", label: "左上角" },
		];

		function Toggle({ on, label, onToggle }) {
			return React.createElement(
				"button",
				{
					type: "button",
					role: "switch",
					"aria-checked": on,
					"aria-label": label,
					onClick: onToggle,
					style: {
						flex: "0 0 auto",
						position: "relative",
						width: 44,
						height: 26,
						padding: 0,
						border: 0,
						borderRadius: 13,
						background: on ? "#2f6fed" : "rgba(128,128,128,0.35)",
						transition: "background 160ms ease",
						cursor: "pointer",
					},
				},
				React.createElement("span", {
					"aria-hidden": true,
					style: {
						position: "absolute",
						top: 3,
						left: on ? 21 : 3,
						width: 20,
						height: 20,
						borderRadius: "50%",
						background: "#fff",
						boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
						transition: "left 160ms ease",
					},
				}),
			);
		}

		function Row({ label, blurb, control }) {
			return React.createElement(
				"div",
				{ style: rowStyle },
				React.createElement(
					"div",
					null,
					React.createElement("div", { style: labelStyle }, label),
					blurb ? React.createElement("div", { style: blurbStyle }, blurb) : null,
				),
				control,
			);
		}

		function SettingsPage() {
			const [settings, setSettings] = React.useState(() => readSettings());
			React.useEffect(() => subscribeSettings((s) => setSettings({ ...patchDefaults, ...s })), []);
			const set = (patch) => writeSettings(patch);
			return React.createElement(
				"div",
				{ style: { display: "flex", flexDirection: "column" } },
				React.createElement(
					"div",
					{ style: sourceStyle },
					"本页由插件 @dsh-external/dsh-balance 提供：DeepSeek 余额悬浮球。",
				),
				React.createElement(Row, {
					label: "启用悬浮球",
					blurb: "在页面右下角显示余额，点击可看明细与充值",
					control: React.createElement(Toggle, {
						on: !!settings.enabled,
						label: "启用悬浮球",
						onToggle: () => set({ enabled: !settings.enabled }),
					}),
				}),
				React.createElement(Row, {
					label: "刷新间隔（秒）",
					blurb: "自动向 DeepSeek 查询余额的频率",
					control: React.createElement("input", {
						type: "number",
						min: 10,
						step: 10,
						value: settings.refreshSeconds ?? 60,
						onChange: (e) => set({ refreshSeconds: Number(e.target.value) || 60 }),
						style: inputStyle,
					}),
				}),
				React.createElement(Row, {
					label: "低余额阈值（¥）",
					blurb: "余额低于该值时悬浮球变红提醒",
					control: React.createElement("input", {
						type: "number",
						min: 0,
						step: 1,
						value: settings.lowBalanceThreshold ?? 5,
						onChange: (e) => set({ lowBalanceThreshold: Math.max(0, Number(e.target.value) || 0) }),
						style: inputStyle,
					}),
				}),
				React.createElement(Row, {
					label: "悬浮位置",
					blurb: "默认位置；拖动悬浮球后以拖动位置为准",
					control: React.createElement(
						"select",
						{
							value: settings.position || "bottom-right",
							onChange: (e) => set({ position: e.target.value }),
							style: inputStyle,
						},
						POSITIONS.map((p) =>
							React.createElement("option", { key: p.value, value: p.value }, p.label),
						),
					),
				}),
			);
		}

		// ------------------------------------------------------------------
		// 插件入口
		// ------------------------------------------------------------------
		/**
		 * @param {import('@deepseek-ai/dsh-client-runtime/client').ClientContext} ctx - 客户端上下文。
		 * @param {object} [rawConfig] - patch 传入的配置（作为默认值兜底）。
		 * @returns {() => void} 清理函数。
		 */
		function apply(ctx, rawConfig) {
			patchDefaults = { ...DEFAULTS, ...(rawConfig || {}) };

			// 1) 注册设置页
			ctx.slots.inject("settings.section", () => ctx.slots.register(
				{
					name: "settings.section",
					id: "余额悬浮球",
					order: 96,
					label: () => "余额悬浮球",
					inject: () => ({}),
				},
				SettingsPage,
			));

			// 2) 悬浮球：随设置实时启停与调参
			const widget = createWidget(() => readSettings());
			if (readSettings().enabled) widget.start();
			const unsubSettings = subscribeSettings(() => {
				const s = readSettings();
				if (s.enabled) widget.start();
				else widget.stop();
				widget.applySettings();
			});

			return () => {
				unsubSettings();
				widget.stop();
			};
		}

		exports.name = "dsh-balance";
		exports.inject = ["slots"];
		exports.apply = apply;
		return module.exports;
	},
});
