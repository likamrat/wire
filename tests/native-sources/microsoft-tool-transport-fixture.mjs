// Invented transport with the source-established ordering: reconnect listeners
// run before the new port is returned to the native sender.
export function inventedToolBridge() {
    return class Bridge {
        static singleton;
        static sent = [];
        static disconnected = 0;
        static instance() { return this.singleton ??= new this(); }
        constructor() { this.port = undefined; this.listeners = new Set(); this.reconnectListeners = new Set(); }
        addReconnectListener(work) { this.reconnectListeners.add(work); return () => this.reconnectListeners.delete(work); }
        ensurePort() {
            if (this.port) return this.port;
            let connected = true;
            const port = {
                disconnect() { connected = false; Bridge.disconnected++; },
                postMessage(message) {
                    if (!connected) throw new Error("Invented disconnected port");
                    Bridge.sent.push(message.eventName);
                },
            };
            this.port = port;
            for (const listener of this.reconnectListeners) {
                try { listener(port); } catch { /* Native dispatcher continues to later listeners. */ }
            }
            return port;
        }
        postMessageWithStaleRetry(message) {
            for (let attempt = 0; attempt < 2; attempt++) {
                try { this.ensurePort().postMessage(message); return true; }
                catch {
                    if (attempt === 0) this.port = undefined;
                }
            }
            return false;
        }
        send(eventName) { return this.postMessageWithStaleRetry({ eventName }); }
    };
}
