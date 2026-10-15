// Ограничители одновременной работы: не больше n задач сразу (limiter) или по правилу для работ
// разных видов (workPool — очередь к диску у облегчённой копии и сборки, см. pipeline.js); остальные ждут.
//
// Кого пустить, когда место освободилось: ожидающего с меньшим priority() (у видео — место в списке,
// чтобы там, где это ничего не стоит, работа шла в порядке списка); при равенстве — кто раньше встал.

/**
 * Очередь к общему ресурсу для работ разных видов (у диска — облегчённая копия и сборка видео).
 * fits(kind, busy) решает, можно ли начать ещё одну работу вида kind, когда уже идут busy = { вид: сколько };
 * правило может зависеть от настроек — после их смены вызвать wake(). Из ожидающих, кому уже можно,
 * первым идёт вид с меньшим rank, затем меньший priority(), затем кто раньше встал.
 * @returns { acquire(kind, signal?, priority?): Promise<release> & { granted }, wake() }
 */
export function workPool(fits, rank = {}) {
  const busy = {};
  const waiting = []; // { kind, go, priority: () => number, seq }
  let seq = 0;

  const before = (a, b) => {
    const ra = rank[a.kind] ?? 0, rb = rank[b.kind] ?? 0;
    if (ra !== rb) return ra < rb;
    const pa = a.priority(), pb = b.priority();
    if (pa !== pb) return pa < pb;
    return a.seq < b.seq;
  };

  function wake() {
    for (;;) {
      let best = -1;
      for (let i = 0; i < waiting.length; i++) {
        if (fits(waiting[i].kind, busy) && (best < 0 || before(waiting[i], waiting[best]))) best = i;
      }
      if (best < 0) return;
      const [entry] = waiting.splice(best, 1);
      busy[entry.kind] = (busy[entry.kind] ?? 0) + 1;
      entry.go();
    }
  }

  return {
    wake,
    /**
     * Ждёт, пока работе этого вида можно начаться; отмена (signal) снимает из ожидания. priority — число
     * или функция (меньше — раньше). Возвращает «освободить»; у промиса granted = true, когда место дали.
     */
    acquire(kind, signal, priority = Infinity) {
      if (signal?.aborted) return Object.assign(Promise.reject(new Error("Отменено")), { granted: false });
      const getPriority = typeof priority === "function" ? priority : () => priority;
      const entry = { kind, seq: seq++, priority: () => { const p = getPriority(); return Number.isFinite(p) ? p : Infinity; } };
      let ticket;
      const promise = new Promise((resolve, reject) => {
        const onAbort = () => {
          const i = waiting.indexOf(entry);
          if (i >= 0) waiting.splice(i, 1);
          reject(new Error("Отменено"));
        };
        entry.go = () => {
          ticket.granted = true;
          signal?.removeEventListener("abort", onAbort);
          let done = false;
          resolve(() => {
            if (done) return; // повторный вызов ничего не ломает
            done = true;
            busy[kind]--;
            wake();
          });
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      ticket = Object.assign(promise, { granted: false });
      waiting.push(entry);
      wake();
      return ticket;
    },
  };
}

/** @returns { acquire(signal?, priority?): Promise<release>, busy(): boolean } */
export function limiter(n = 1) {
  let free = n;
  let seq = 0;
  const waiting = []; // { go, priority: () => number, seq }

  function next() {
    if (!waiting.length) return null;
    let best = 0;
    for (let i = 1; i < waiting.length; i++) {
      const a = waiting[i], b = waiting[best];
      const pa = a.priority(), pb = b.priority();
      if (pa < pb || (pa === pb && a.seq < b.seq)) best = i;
    }
    return waiting.splice(best, 1)[0];
  }

  function makeRelease() {
    let done = false;
    return () => {
      if (done) return; // повторный вызов ничего не ломает
      done = true;
      const entry = next();
      if (entry) entry.go();
      else free++;
    };
  }

  return {
    /** Сразу ли дадут очередь (для подписи «ждём…»). */
    busy: () => free === 0,
    /**
     * Ждёт своей очереди; отмена (signal) снимает из ожидания. priority — число или функция
     * (меньше — раньше; функция спрашивается в момент, когда место освободилось). Возвращает «освободить».
     */
    acquire(signal, priority = Infinity) {
      if (signal?.aborted) return Promise.reject(new Error("Отменено"));
      if (free > 0) {
        free--;
        return Promise.resolve(makeRelease());
      }
      const getPriority = typeof priority === "function" ? priority : () => priority;
      return new Promise((resolve, reject) => {
        const entry = { priority: () => { const p = getPriority(); return Number.isFinite(p) ? p : Infinity; }, seq: seq++ };
        const onAbort = () => {
          const i = waiting.indexOf(entry);
          if (i >= 0) waiting.splice(i, 1);
          reject(new Error("Отменено"));
        };
        entry.go = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(makeRelease());
        };
        waiting.push(entry);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}
