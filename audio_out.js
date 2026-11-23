// Audio output on an AudioWorklet (its own thread).
// - Sound effects: the game's OpenSL mixer (sl_render) is pulled on the main thread
//   each frame into a shared ring buffer that the worklet plays from.
// - Music (<audio> elements) is routed through the same worklet.
// - Freeze guard: the main thread bumps a heartbeat every frame; if it stops for
//   more than FREEZE_MS the worklet fades everything out (and drops stale effects)
//   until frames come again.
(() => {
  const FREEZE_MS = 120;
  const RING_FRAMES = 16384;          // capacity (stereo frames)
  const TARGET_FRAMES = 3072;         // keep ~64 ms queued

  const WORKLET_SRC = `
    class GameOut extends AudioWorkletProcessor {
      constructor(opts) {
        super();
        const o = opts.processorOptions;
        if (o.mem) {                           // ring filled by the runtime's audio thread, in wasm memory
          this.ring = new Float32Array(o.mem, o.ringOff, o.ringFrames * 2);
          this.wr = new Int32Array(o.mem, o.ctlOff, 2);
        } else {
          this.ring = new Float32Array(o.ring);
        }
        this.ctl = new Int32Array(o.ctl);      // 0 write, 1 read (frame counters), 2 heartbeat, 3 user mute
        if (!this.wr) this.wr = this.ctl;
        this.cap = this.ring.length / 2;
        this.lastBeat = -1;
        this.still = 0;
        this.freezeQuanta = o.freezeQuanta;
        this.gain = 0;
      }
      process(inputs, outputs) {
        const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length;
        const beat = Atomics.load(this.ctl, 2);
        if (beat !== this.lastBeat) { this.lastBeat = beat; this.still = 0; } else this.still++;
        const frozen = this.still > this.freezeQuanta;
        const target = frozen || Atomics.load(this.ctl, 3) ? 0 : 1;
        const w = Atomics.load(this.wr, 0);
        let r = Atomics.load(this.wr, 1);
        if (frozen) r = w;                     // effects queued before the freeze would play late: drop them
        const inp = inputs[0], mL = inp && inp[0], mR = inp && (inp[1] || inp[0]);
        for (let i = 0; i < n; i++) {
          this.gain += (target - this.gain) * 0.004;
          let l = 0, rr = 0;
          if (((w - r) | 0) > 0) { const k = ((r >>> 0) % this.cap) * 2; l = this.ring[k]; rr = this.ring[k + 1]; r = (r + 1) | 0; }
          if (mL) { l += mL[i]; rr += mR[i]; }
          L[i] = l * this.gain;
          if (R !== L) R[i] = rr * this.gain;
        }
        Atomics.store(this.wr, 1, r);
        return true;
      }
    }
    registerProcessor('game-out', GameOut);`;

  window.AudioOut = {
    async start(Mod) {
      const ctx = new AudioContext({latencyHint: 'interactive'});
      await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET_SRC], {type: 'text/javascript'})));
      const ringSab = new SharedArrayBuffer(RING_FRAMES * 2 * 4), ctlSab = new SharedArrayBuffer(16);
      const ring = new Float32Array(ringSab), ctl = new Int32Array(ctlSab);
      const opts = {ring: ringSab, ctl: ctlSab, freezeQuanta: Math.ceil(FREEZE_MS / 1000 * ctx.sampleRate / 128)};
      // runtimes with an audio thread mix into a ring in wasm memory; the page only beats
      const threaded = !!Mod._sl_out_attach;
      if (threaded) {
        const p = Mod._sl_out_attach(ctx.sampleRate) >>> 0;
        Object.assign(opts, {mem: Mod.heap().buffer, ctlOff: p, ringOff: p + 16, ringFrames: Mod._sl_out_ring_frames()});
      }
      const node = new AudioWorkletNode(ctx, 'game-out', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: opts,
      });
      node.connect(ctx.destination);
      if (!threaded) Mod._sl_set_rate(ctx.sampleRate);
      const CHUNK = 512;
      const buf = Mod._malloc(CHUNK * 2 * 4);
      let beat = 0;
      const routed = new WeakSet();
      const api = {
        ctx, node,
        // once per frame on the main thread
        pump() {
          Atomics.store(ctl, 2, ++beat);
          if (threaded) return;
          let w = Atomics.load(ctl, 0);
          const r = Atomics.load(ctl, 1);
          let fill = (w - r) | 0;
          while (fill < TARGET_FRAMES) {
            const n = Math.min(CHUNK, TARGET_FRAMES - fill);
            Mod._sl_render(buf, n);
            const f = new Float32Array(Mod.heap().buffer, buf, n * 2);
            for (let i = 0; i < n; i++) {
              const k = (((w + i) >>> 0) % RING_FRAMES) * 2;
              ring[k] = f[2 * i]; ring[k + 1] = f[2 * i + 1];
            }
            w = (w + n) | 0;
            fill += n;
          }
          Atomics.store(ctl, 0, w);
        },
        route(el) {
          if (!el || routed.has(el)) return;
          routed.add(el);
          try { ctx.createMediaElementSource(el).connect(node); } catch (e) { console.warn('[audio] music routing', e); }
        },
        setMuted(m) { Atomics.store(ctl, 3, m ? 1 : 0); },
        isMuted() { return Atomics.load(ctl, 3) === 1; },
      };
      return api;
    },
  };
})();
