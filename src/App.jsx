import { useCallback, useRef, useState } from 'react';
import { loadPdf, invertPdf } from './pdf.js';

const STATUS = {
  IDLE: 'idle',
  LOADED: 'loaded',
  PROCESSING: 'processing',
  DONE: 'done',
};

export default function App() {
  const [fileName, setFileName] = useState('');
  const [numPages, setNumPages] = useState(0);
  const [buffer, setBuffer] = useState(null); // ArrayBuffer исходного PDF
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [status, setStatus] = useState(STATUS.IDLE);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  const reset = () => {
    setFileName('');
    setNumPages(0);
    setBuffer(null);
    setStart('');
    setEnd('');
    setStatus(STATUS.IDLE);
    setProgress({ done: 0, total: 0 });
    setError('');
  };

  const handleFile = useCallback(async (file) => {
    setError('');
    if (!file) return;
    if (file.type && file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setError('Это не PDF-файл. Выберите файл с расширением .pdf.');
      return;
    }
    try {
      const arrayBuffer = await file.arrayBuffer();
      // loadPdf копирует данные во внутренний воркер; держим отдельную копию
      // для повторной обработки, т.к. PDF.js «забирает» переданный буфер.
      const probe = arrayBuffer.slice(0);
      const { numPages: pages } = await loadPdf(probe);
      setBuffer(arrayBuffer);
      setNumPages(pages);
      setFileName(file.name);
      setStart('');
      setEnd('');
      setStatus(STATUS.LOADED);
    } catch {
      reset();
      setError('Не удалось открыть PDF: файл повреждён или имеет неподдерживаемый формат.');
    }
  }, []);

  const onInputChange = (e) => handleFile(e.target.files?.[0]);

  const onDrop = (e) => {
    e.preventDefault();
    handleFile(e.dataTransfer.files?.[0]);
  };

  // Возвращает { from, to } или строку с ошибкой валидации.
  const resolveRange = () => {
    const trimmedStart = start.trim();
    const trimmedEnd = end.trim();

    // Диапазон не задан целиком — весь документ.
    if (trimmedStart === '' && trimmedEnd === '') {
      return { from: 1, to: numPages };
    }

    const from = trimmedStart === '' ? 1 : Number(trimmedStart);
    const to = trimmedEnd === '' ? numPages : Number(trimmedEnd);

    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      return 'Номера страниц должны быть целыми числами.';
    }
    if (from < 1 || to > numPages) {
      return `Диапазон должен быть в пределах 1…${numPages}.`;
    }
    if (from > to) {
      return 'Начальная страница не может быть больше конечной.';
    }
    return { from, to };
  };

  const onProcess = async () => {
    setError('');
    const range = resolveRange();
    if (typeof range === 'string') {
      setError(range);
      return;
    }

    setStatus(STATUS.PROCESSING);
    setProgress({ done: 0, total: range.to - range.from + 1 });

    try {
      // Отдаём свежую копию буфера: PDF.js переносит ArrayBuffer во воркер.
      const bytes = await invertPdf(buffer.slice(0), {
        start: range.from,
        end: range.to,
        onProgress: (done, total) => setProgress({ done, total }),
      });

      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName.replace(/\.pdf$/i, '') + '-inverted.pdf';
      a.click();
      URL.revokeObjectURL(url);

      setStatus(STATUS.DONE);
    } catch {
      setError('Ошибка при обработке PDF. Попробуйте другой файл или меньший диапазон страниц.');
      setStatus(STATUS.LOADED);
    }
  };

  const busy = status === STATUS.PROCESSING;
  const percent = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <main className="app">
      <h1>PDF Inverter</h1>
      <p className="subtitle">
        Инвертирует цвета PDF (белое ↔ чёрное) и вырезает диапазон страниц — прямо в браузере,
        файл никуда не загружается.
      </p>

      <div
        className="dropzone"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          onChange={onInputChange}
          hidden
        />
        {fileName ? (
          <span>
            <strong>{fileName}</strong> — {numPages} стр.
          </span>
        ) : (
          <span>Перетащите PDF сюда или нажмите, чтобы выбрать</span>
        )}
      </div>

      {status !== STATUS.IDLE && (
        <section className="controls">
          <div className="range">
            <label>
              С страницы
              <input
                type="number"
                min="1"
                max={numPages}
                value={start}
                placeholder="1"
                disabled={busy}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label>
              По страницу
              <input
                type="number"
                min="1"
                max={numPages}
                value={end}
                placeholder={String(numPages)}
                disabled={busy}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
            <span className="hint">Пусто = весь документ ({numPages} стр.)</span>
          </div>

          <div className="actions">
            <button onClick={onProcess} disabled={busy}>
              {busy ? 'Обработка…' : 'Инвертировать и скачать'}
            </button>
            <button className="secondary" onClick={reset} disabled={busy}>
              Сбросить
            </button>
          </div>
        </section>
      )}

      {busy && (
        <div className="progress">
          <div className="progress-bar" style={{ width: `${percent}%` }} />
          <span>
            Страница {progress.done} из {progress.total} ({percent}%)
          </span>
        </div>
      )}

      {status === STATUS.DONE && !error && (
        <p className="success">Готово — инвертированный PDF скачан.</p>
      )}

      {error && <p className="error">{error}</p>}
    </main>
  );
}
