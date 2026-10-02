// dsh-mail 客户端：侧边栏底部的全局「离开模式」开关。
// - 模块格式：window.__ModuleLoader__.load({ id, factory })，id 必须等于包名。
// - React / primitives 来自 Web 壳的 seed 模块表（factory 的 require），不打包、不需要构建。
// - 后端：宿主插件提供的 SRC Remote 服务 dshMail（get / setAway），通过 connection.rpc 调用。
//   宿主事件无法推给浏览器（转发白名单写死），所以用 5 秒轮询 + 窗口聚焦 + 重连时刷新。
window.__ModuleLoader__.load({
	id: "dsh-mail",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const P = require("@deepseek-ai/dsh-client-ui-primitives");
		const el = React.createElement;

		const NS = "dshMail";
		const POLL_MS = 5000;

		function createSource(connection) {
			let snap = { status: "loading", away: false, busy: false, error: undefined, info: undefined };
			const listeners = new Set();
			const publish = (patch) => {
				snap = Object.assign({}, snap, patch);
				for (const fn of Array.from(listeners)) fn();
			};
			const call = async (method, args) => {
				const r = await connection.rpc.call("/api", NS + "/" + method, { args });
				if (!r || !r.ok) throw new Error(r && r.error ? r.error.code + ": " + r.error.message : "rpc failed");
				return r.value;
			};
			const accept = (v) => publish({ status: "ready", away: !!(v && v.away), info: v, error: undefined });
			const refresh = () =>
				call("get", {}).then(accept, (e) => publish({ status: "error", error: String((e && e.message) || e) }));
			return {
				getSnapshot: () => snap,
				subscribe: (fn) => {
					listeners.add(fn);
					return () => listeners.delete(fn);
				},
				refresh,
				async toggle() {
					if (snap.busy) return;
					publish({ busy: true });
					try {
						// 参数名必须与宿主方法形参名一致（SRC 按形参名取 args）
						accept(await call("setAway", { away: !snap.away }));
					} catch (e) {
						publish({ error: String((e && e.message) || e) });
						refresh();
					} finally {
						publish({ busy: false });
					}
				},
			};
		}

		function tipFor(s) {
			if (s.status === "error") return "dsh-mail 不可用：" + s.error;
			const info = s.info || {};
			const lines = [
				s.away ? "离开模式已开启：Agent 有事会发邮件给你。点击关闭" : "在电脑前：Agent 不会主动发邮件。点击开启离开模式",
			];
			if (info.notifyTo) lines.push("收件地址：" + info.notifyTo);
			if (!info.enabled) lines.push("⚠ 邮件通道未启用：" + (info.lastError || "配置有误"));
			else if (info.lastError) lines.push("⚠ 收信异常：" + info.lastError);
			return lines.join("\n");
		}

		function makeToggle(source) {
			return function DshMailAwayToggle(props) {
				const wide = props.wide !== false; // owner props：{ wide }（false = 窄栏）
				const s = React.useSyncExternalStore(source.subscribe, source.getSnapshot);
				const on = s.away;
				const info = s.info || {};
				const warn = s.status === "error" || (s.status === "ready" && (!info.enabled || !!info.lastError));
				const dot = el("span", {
					"aria-hidden": "true",
					style: {
						width: 8,
						height: 8,
						borderRadius: 999,
						flex: "none",
						background: warn
							? "var(--dsw-alias-state-warn-primary, #f59e0b)"
							: on
								? "var(--dsw-alias-state-success-primary, #22c55e)"
								: "var(--dsw-alias-label-tertiary)",
					},
				});
				const button = el(
					"button",
					{
						type: "button",
						role: "switch",
						"aria-checked": on,
						"aria-label": on ? "离开模式：开" : "离开模式：关",
						"data-dsh-mail-away": on ? "on" : "off",
						disabled: s.busy || s.status === "loading",
						onClick: () => source.toggle(),
						style: {
							display: "inline-flex",
							alignItems: "center",
							gap: 8,
							height: 36,
							minWidth: 36,
							justifyContent: wide ? "flex-start" : "center",
							padding: wide ? "0 10px" : 0,
							margin: wide ? "0 2px 4px" : "0 0 4px",
							border: "none",
							borderRadius: "var(--dsw-radius-md, 10px)",
							background: on ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
							color: "var(--dsw-alias-label-primary)",
							font: "inherit",
							cursor: s.busy ? "progress" : "pointer",
							opacity: s.status === "loading" ? 0.6 : 1,
						},
					},
					dot,
					wide ? el("span", { style: { whiteSpace: "nowrap" } }, on ? "离开模式" : "在电脑前") : null,
				);
				return P && P.Tooltip
					? el(P.Tooltip, { label: el("span", { style: { whiteSpace: "pre-line" } }, tipFor(s)), side: wide ? "top" : "right", portal: true }, button)
					: button;
			};
		}

		function apply(ctx) {
			const source = createSource(ctx.connection);
			const Toggle = makeToggle(source);
			ctx.effect(() => {
				source.refresh();
				const timer = setInterval(source.refresh, POLL_MS);
				const onFocus = () => source.refresh();
				window.addEventListener("focus", onFocus);
				return () => {
					clearInterval(timer);
					window.removeEventListener("focus", onFocus);
				};
			}, "dsh-mail: away polling");
			ctx.on("connection/reset", () => source.refresh());
			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register({ name: "sidebar.footer.action", id: "dsh-mail-away", order: -10, label: "离开模式" }, Toggle),
			);
		}

		exports.name = "dsh-mail-client";
		exports.inject = ["slots", "connection"];
		exports.apply = apply;
		return module.exports;
	},
});
