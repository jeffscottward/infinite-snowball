Object.defineProperty(globalThis, "Function", {
	configurable: true,
	writable: true,
	value: function blockedDynamicFunction() {
		throw new Error("dynamic Function construction is forbidden in the engine gate");
	},
});
