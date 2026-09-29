// Ограничитель одновременной работы (семафор): не больше n задач сразу, остальные ждут.
// Нужен, когда видео переводятся параллельно: загрузка и ожидание Яндекса идут вместе, а чтение
// многогигабайтного исходника и запись результата — по одному, иначе диск мечется между файлами
// и всё идёт медленнее, чем по очереди.
//
// Кого пустить, когда место освободилось: ожидающего с меньшим priority() (у видео — место в списке,
// чтобы там, где это ничего не стоит, работа шла в порядке списка); при равенстве — кто раньше встал.

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
