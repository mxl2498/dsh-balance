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
			showPricing: true,
			defaultModel: "deepseek-v4-flash",
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
		/** 服务端价格代理路由。 */
		const PRICING_ROUTE = "/dsh-balance/pricing";
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
				pricing: null,
				pricingError: "",
			};
			// 悬浮球内部行
			let pillLine = null;
			let priceLine = null;
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
					"flex-direction:column",
					"align-items:flex-start",
					"justify-content:center",
					"gap:1px",
					"padding:5px 12px",
					"border-radius:999px",
					"border:1px solid rgba(255,255,255,0.16)",
					"background:rgba(24,26,32,0.88)",
					"color:#e8eaf0",
					"font-family:inherit",
					"cursor:pointer",
					"box-shadow:0 4px 16px rgba(0,0,0,0.25)",
					"backdrop-filter:blur(8px)",
					"transition:background .15s ease",
					"line-height:1.25",
				].join(";"));

				pillLine = document.createElement("span");
				pillLine.style.cssText = "font-size:12px;font-weight:600;";

				priceLine = document.createElement("span");
				priceLine.style.cssText = "font-size:10px;font-weight:400;opacity:0.85;white-space:nowrap;";

				pill.appendChild(pillLine);
				pill.appendChild(priceLine);

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
				pillLine = null;
				priceLine = null;
				card = null;
				rowsEl = null;
				refreshBtn = null;
				topupBtn = null;
			}

			function lowBalance() {
				const n = Number(state.total);
				return Number.isFinite(n) && n < getSettings().lowBalanceThreshold;
			}

			/** 模型简称（悬浮球空间有限）。 */
			function modelShortName(id) {
				const map = {
					"deepseek-v4-flash": "Flash",
					"deepseek-v4-pro": "Pro",
					"deepseek-v4-flash-vision-exp": "Flash-Vis",
				};
				return map[id] || String(id).replace(/^deepseek-v4-/, "") || id;
			}

			/** 当前是否处于"周末全天低谷"规则下（规则已生效且今天是周六/周日）。 */
			function isWeekendFlat() {
				const s = state;
				if (!s.pricing || !s.pricing.weekendFlat) return false;
				if (!s.pricing.weekendFlatStart || Date.now() < s.pricing.weekendFlatStart) return false;
				const bjDay = new Date(Date.now() + 8 * 3600 * 1000).getUTCDay();
				return bjDay === 0 || bjDay === 6;
			}

			/** 当前模型费率行的文本（实时高峰/空闲，周末显示低谷）。 */
			function pricingLineText() {
				const s = state;
				if (s.pricingError) return "费率获取失败";
				if (!s.pricing || !Array.isArray(s.pricing.models) || !s.pricing.models.length) return "费率 …";
				const settings = getSettings();
				const model = s.pricing.models.find((m) => m.id === settings.defaultModel) || s.pricing.models[0];
				if (!model) return "费率 --";
				const period = s.pricing.currentPeriod === "peak" ? "peak" : "offPeak";
				const periodLabel = isWeekendFlat() ? "低谷" : (period === "peak" ? "高峰" : "空闲");
				const input = model.input && model.input.cacheMiss ? model.input.cacheMiss[period] : null;
				const fmt = (v) => (v == null ? "--" : (Number.isInteger(v) ? String(v) : v.toFixed(2)));
				return modelShortName(model.id) + " 入" + fmt(input) + "元/M·" + periodLabel;
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
				pillLine.textContent = warn + text;
				pill.style.background = bg;
				pill.style.color = fg;
				// 费率行（实时显示当前模型费率）
				const pl = pricingLineText();
				if (pl && getSettings().showPricing) {
					priceLine.style.display = "";
					priceLine.textContent = pl;
				} else {
					priceLine.style.display = "none";
				}
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
				// 费率提示
				if (s.pricing && Array.isArray(s.pricing.models) && s.pricing.models.length) {
					const period = s.pricing.currentPeriod === "peak" ? "peak" : "offPeak";
					const flat = isWeekendFlat();
					const periodLabel = flat ? "低谷（周末全天）" : (period === "peak" ? "高峰" : "空闲");
					tip.push("当前时段：" + periodLabel + "（" + (s.pricing.peakSlots || []).map((x) => x[0] + "-" + x[1] + "点").join("、") + "）");
					if (s.pricing.weekendFlat) tip.push("周末（周六/周日）全天按低谷价");
					const model = s.pricing.models.find((m) => m.id === getSettings().defaultModel) || s.pricing.models[0];
					if (model) {
						const fmt = (v) => (v == null ? "--" : (Number.isInteger(v) ? String(v) : v.toFixed(2)));
						const hit = model.input && model.input.cacheHit ? model.input.cacheHit[period] : null;
						const miss = model.input && model.input.cacheMiss ? model.input.cacheMiss[period] : null;
						const out = model.output ? model.output[period] : null;
						tip.push(model.id + "：输入(缓存命中) " + fmt(hit) + "元/M，输入(未命中) " + fmt(miss) + "元/M，输出 " + fmt(out) + "元/M");
					}
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
				renderPricingSection(rowsEl, s);
			}

			/** 卡片里的费率区块：当前时段 + 当前模型费率 + 全部模型简表。 */
			function renderPricingSection(container, s) {
				const divider = document.createElement("div");
				divider.style.cssText = "height:1px;background:rgba(128,128,128,0.25);margin:10px 0 8px;";
				container.appendChild(divider);

				const title = document.createElement("div");
				title.style.cssText = "font-size:11px;font-weight:600;color:#9aa0ad;margin-bottom:6px;";
				title.textContent = "模型费率（官网实时）";
				container.appendChild(title);

				if (s.pricingError) {
					const err = document.createElement("div");
					err.textContent = "费率获取失败：" + s.pricingError;
					err.style.color = "#f0a0a0";
					err.style.whiteSpace = "pre-wrap";
					container.appendChild(err);
					return;
				}
				if (!s.pricing || !Array.isArray(s.pricing.models) || !s.pricing.models.length) {
					const ld = document.createElement("div");
					ld.textContent = "费率加载中…";
					ld.style.color = "#9aa0ad";
					container.appendChild(ld);
					return;
				}

				const period = s.pricing.currentPeriod === "peak" ? "peak" : "offPeak";
				const flat = isWeekendFlat();
				const periodLabel = flat ? "低谷时段（周末全天）" : (period === "peak" ? "高峰时段" : "空闲时段");
				const periodEl = document.createElement("div");
				periodEl.style.cssText = "display:inline-block;padding:1px 8px;border-radius:99px;font-size:10px;margin-bottom:8px;" +
					(flat || period === "offPeak"
						? "background:rgba(47,111,237,0.25);color:#9ec4ff;"
						: "background:rgba(176,44,44,0.3);color:#f0a0a0;");
				periodEl.textContent = periodLabel + "（" + (s.pricing.peakSlots || []).map((x) => x[0] + "-" + x[1] + "点").join("、") + "）";
				container.appendChild(periodEl);
				if (s.pricing.weekendFlat) {
					const note = document.createElement("div");
					note.style.cssText = "font-size:10px;color:#8a93a5;margin-bottom:6px;";
					note.textContent = "周末（周六/周日）全天按低谷价，不区分峰谷时段";
					container.appendChild(note);
				}

				const fmt = (v) => (v == null ? "--" : (Number.isInteger(v) ? String(v) : v.toFixed(2)));
				const fmtPair = (a, b) => fmt(a) + " / " + fmt(b);

				const settings = getSettings();
				const current = s.pricing.models.find((m) => m.id === settings.defaultModel) || s.pricing.models[0];
				const others = s.pricing.models.filter((m) => m !== current);

				// 当前模型详情
				if (current) {
					const head = document.createElement("div");
					head.style.cssText = "font-size:11px;font-weight:600;color:#e8eaf0;margin:4px 0 2px;";
					head.textContent = modelShortName(current.id) + "（" + current.id + "）· 空闲/高峰 元/M";
					container.appendChild(head);
					const hit = current.input && current.input.cacheHit ? current.input.cacheHit : {};
					const miss = current.input && current.input.cacheMiss ? current.input.cacheMiss : {};
					const out = current.output || {};
					container.appendChild(row("输入 · 缓存命中", fmtPair(hit.offPeak, hit.peak)));
					container.appendChild(row("输入 · 未命中", fmtPair(miss.offPeak, miss.peak)));
					container.appendChild(row("输出", fmtPair(out.offPeak, out.peak)));
				}

				// 其他模型简表
				if (others.length) {
					const sub = document.createElement("div");
					sub.style.cssText = "font-size:11px;font-weight:600;color:#9aa0ad;margin:8px 0 2px;";
					sub.textContent = "其他模型";
					container.appendChild(sub);
					for (const m of others) {
						const miss = m.input && m.input.cacheMiss ? m.input.cacheMiss : {};
						const out = m.output || {};
						const v = document.createElement("div");
						v.style.cssText = "display:flex;justify-content:space-between;gap:12px;";
						const l = document.createElement("span");
						l.textContent = modelShortName(m.id);
						l.style.color = "#9aa0ad";
						const r = document.createElement("span");
						r.textContent = "入 " + fmtPair(miss.offPeak, miss.peak) + " · 出 " + fmtPair(out.offPeak, out.peak);
						r.style.color = "#e8eaf0";
						v.appendChild(l);
						v.appendChild(r);
						container.appendChild(v);
					}
				}

				const src = document.createElement("div");
				src.style.cssText = "font-size:10px;color:#6b7280;margin-top:8px;";
				src.textContent = "来源：DeepSeek 官网 · 更新 " + formatTime(s.pricing.fetchedAt);
				container.appendChild(src);
			}

			/** 抓取官网费率（服务端解析并缓存）。 */
			async function refreshPricing() {
				try {
					const res = await fetch(PRICING_ROUTE, { cache: "no-store" });
					const body = await res.json();
					if (body && body.ok) {
						state = { ...state, pricing: body, pricingError: "" };
					} else {
						state = { ...state, pricing: null, pricingError: (body && body.message) || "服务端返回异常" };
					}
				} catch (err) {
					state = { ...state, pricing: null, pricingError: String((err && err.message) || err) };
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
							pricing: state.pricing,
							pricingError: state.pricingError,
						};
					} else {
						state = {
							status: "error",
							total: null,
							infos: [],
							fetchedAt: null,
							topUpUrl: FALLBACK_TOP_UP_URL,
							message: (body && body.message) || "服务端返回异常",
							pricing: state.pricing,
							pricingError: state.pricingError,
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
						pricing: state.pricing,
						pricingError: state.pricingError,
					};
				}
				await refreshPricing();
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
					// 视口边界校验：记忆位置必须完整落在可视区内，否则清除记忆并回退默认位置
					// （修复：悬浮球被拖出屏幕外后"消失"的问题）
					const vw = window.innerWidth;
					const vh = window.innerHeight;
					const w = Math.max(root.offsetWidth || 0, 40);
					const h = Math.max(root.offsetHeight || 0, 24);
					if (saved.left >= 0 && saved.top >= 0 && saved.left + w <= vw && saved.top + h <= vh) {
						root.style.left = saved.left + "px";
						root.style.top = saved.top + "px";
						root.style.right = "auto";
						root.style.bottom = "auto";
						return;
					}
					try { localStorage.removeItem(POS_KEY); } catch { /* ignore */ }
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

		/** 设置页兜底模型列表（定价接口加载失败时展示）。 */
		const FALLBACK_MODELS = [
			{ id: "deepseek-v4-flash", version: "DeepSeek-V4-Flash-0731" },
			{ id: "deepseek-v4-pro", version: "DeepSeek-V4-Pro-0813" },
			{ id: "deepseek-v4-flash-vision-exp", version: "DeepSeek-V4-Flash-Vision-Exp" },
		];

		function SettingsPage() {
			const [settings, setSettings] = React.useState(() => readSettings());
			const [pricingModels, setPricingModels] = React.useState(null);
			React.useEffect(() => subscribeSettings((s) => setSettings({ ...patchDefaults, ...s })), []);
			React.useEffect(() => {
				fetch(PRICING_ROUTE, { cache: "no-store" })
					.then((r) => r.json())
					.then((body) => { if (body && body.ok && Array.isArray(body.models)) setPricingModels(body.models); })
					.catch(() => {});
			}, []);
			const set = (patch) => writeSettings(patch);
			const models = Array.isArray(pricingModels) && pricingModels.length ? pricingModels : FALLBACK_MODELS;
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
				React.createElement(Row, {
					label: "显示费率",
					blurb: "悬浮球上实时显示当前模型的高峰/空闲费率（来源 DeepSeek 官网）",
					control: React.createElement(Toggle, {
						on: !!settings.showPricing,
						label: "显示费率",
						onToggle: () => set({ showPricing: !settings.showPricing }),
					}),
				}),
				React.createElement(Row, {
					label: "费率模型",
					blurb: "悬浮球显示的费率模型（不影响实际 API 调用，仅用于费率参考）",
					control: React.createElement(
						"select",
						{
							value: settings.defaultModel || "deepseek-v4-flash",
							onChange: (e) => set({ defaultModel: e.target.value }),
							style: inputStyle,
						},
						models.map((m) =>
							React.createElement("option", { key: m.id, value: m.id }, m.id + (m.version ? "（" + m.version + "）" : "")),
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
