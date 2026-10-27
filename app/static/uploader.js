// PhoneDrop — загрузка больших файлов частями (общая для «Передач» и «Посылок»).
// Сервер принимает части строго по порядку. Если связь пропала — ждём 2, 4, 8… до 30 секунд,
// спрашиваем сервер, сколько реально дошло, и продолжаем с этого места.
"use strict";

window.PDUpload = (() => {
  const ROLE = () => document.body.dataset.role || "phone";

  class ChunkUpload {
    /**
     * @param {object} o
     *  file, size, received — что и с какого места грузить
     *  url(offset)          — адрес для PUT очередной части
     *  status()             — async: сколько сервер уже получил (null — загрузки больше нет)
     *  chunkMb              — размер части
     *  onUpdate(job)        — вызывается при каждом изменении (прогресс, пауза, обрыв)
     */
    constructor(o) {
      Object.assign(this, { state: "idle", speed: 0, eta: 0, retry: 0, retryIn: 0, xhr: null }, o);
      this.chunk = (o.chunkMb || 8) * 1024 * 1024;
    }

    put(offset, blob) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        this.xhr = xhr;
        xhr.open("PUT", this.url(offset));
        xhr.setRequestHeader("X-PD-Role", ROLE());
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        let lastTime = Date.now();
        let lastBytes = offset;
        xhr.upload.onprogress = (e) => {
          this.received = offset + e.loaded;
          const now = Date.now();
          const dt = (now - lastTime) / 1000;
          if (dt >= 0.7) {
            const speed = (this.received - lastBytes) / dt;
            this.speed = this.speed ? this.speed * 0.7 + speed * 0.3 : speed;  // сглаживаем скачки
            this.eta = (this.size - this.received) / Math.max(this.speed, 1);
            lastTime = now;
            lastBytes = this.received;
            this.onUpdate(this);
          }
        };
        xhr.onload = () => {
          let data = null;
          try { data = JSON.parse(xhr.responseText); } catch { /* не JSON */ }
          if ((xhr.status === 200 || xhr.status === 409) && data) resolve(data.received);
          else reject(Object.assign(new Error((data && data.detail) || `Ошибка ${xhr.status}`),
            { fatal: xhr.status >= 400 && xhr.status < 500 }));
        };
        xhr.onerror = () => reject(Object.assign(new Error("Нет связи"), { fatal: false }));
        xhr.onabort = () => reject(Object.assign(new Error("Пауза"), { paused: true }));
        xhr.send(blob);
      });
    }

    // Возвращает "done" | "paused" | "gone"; при неисправимой ошибке — исключение.
    async run() {
      this.state = "uploading";
      this.onUpdate(this);
      let offset = this.received;
      while (offset < this.size) {
        if (this.state === "paused") return "paused";
        try {
          offset = await this.put(offset, this.file.slice(offset, offset + this.chunk));
          this.received = offset;
          this.retry = 0;
          if (this.state === "retry") { this.state = "uploading"; this.onUpdate(this); }
        } catch (e) {
          if (e.paused || this.state === "paused") { this.received = offset; this.onUpdate(this); return "paused"; }
          if (e.fatal) { this.state = "error"; this.onUpdate(this); throw e; }
          this.retry += 1;
          this.state = "retry";
          this.retryIn = Math.min(30, 2 ** this.retry);
          this.onUpdate(this);
          await new Promise((r) => setTimeout(r, this.retryIn * 1000));
          if (this.state === "paused") return "paused";
          try {
            const fresh = await this.status();
            if (fresh === null) { this.state = "gone"; return "gone"; }
            offset = fresh;
          } catch { /* связи всё ещё нет — следующий круг */ }
        }
      }
      this.state = "done";
      this.received = this.size;
      this.onUpdate(this);
      return "done";
    }

    pause() {
      this.state = "paused";
      if (this.xhr) this.xhr.abort();
      this.onUpdate(this);
    }
  }

  const fmtSpeed = (bps, fmtSize) => (bps > 0 ? fmtSize(bps) + "/с" : "");
  function fmtEta(sec) {
    if (!isFinite(sec) || sec <= 0) return "";
    if (sec < 60) return `≈ ${Math.ceil(sec)} с`;
    if (sec < 3600) return `≈ ${Math.ceil(sec / 60)} мин`;
    return `≈ ${Math.floor(sec / 3600)} ч ${Math.ceil((sec % 3600) / 60)} мин`;
  }

  // Подпись под полоской прогресса.
  function statusText(job, size, fmtSize) {
    const pct = Math.floor((job.received / size) * 100);
    if (job.state === "paused") return `⏸ Пауза · ${pct}%`;
    if (job.state === "retry") return `📡 Нет связи — повторю через ${job.retryIn} с · ${pct}%`;
    return `${pct}% · ${fmtSize(job.received)} из ${fmtSize(size)} · ${fmtSpeed(job.speed, fmtSize)} ${fmtEta(job.eta)}`;
  }

  // Выбор файла заново после перезагрузки страницы (браузер не помнит файл).
  function pickSame(name, size, onOk, toast, fmtSize) {
    const input = document.createElement("input");
    input.type = "file";
    input.addEventListener("change", () => {
      const file = input.files[0];
      if (!file) return;
      if (file.size !== size || file.name !== name) {
        toast(`Это другой файл. Нужен «${name}» (${fmtSize(size)})`, true);
        return;
      }
      onOk(file);
    });
    input.click();
  }

  return { ChunkUpload, statusText, pickSame };
})();
