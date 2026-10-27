/** The native launcher exposes lifecycle control only to its parent IPC channel. */
export function attachManager(bus: {isPaused(): boolean; setPaused(value: boolean): void}, shutdown: () => Promise<void>) {
    const state = () => bus.isPaused() ? 'paused' : 'running';
    let last = state();
    process.send?.({type: 'ready', state: last});
    const timer = setInterval(() => {
        const next = state();
        if (next !== last) { last = next; process.send?.({type: 'state', state: next}); }
    }, 500);
    timer.unref();
    process.on('message', (message: {type?: string; action?: string; requestId?: string}) => {
        if (message?.type !== 'manager-command') return;
        if (message.action === 'pause' || message.action === 'resume') {
            bus.setPaused(message.action === 'pause');
            process.send?.({type: 'state', state: state(), requestId: message.requestId});
        } else if (message.action === 'shutdown') void shutdown();
    });
    process.once('disconnect', () => void shutdown());
}
