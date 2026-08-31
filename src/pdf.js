import * as pdfjsLib from 'pdfjs-dist';
// Vite подставляет base (`/pdf-inverter/`) в этот URL, поэтому воркер грузится
// корректно и в dev, и из подкаталога GitHub Pages.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument } from 'pdf-lib';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// Масштаб рендера. >= 2, чтобы растровый результат оставался читаемым.
const RENDER_SCALE = 2;
// Качество JPEG для встраивания страниц в итоговый PDF.
const JPEG_QUALITY = 0.85;

/**
 * Загружает PDF из ArrayBuffer и возвращает документ PDF.js и число страниц.
 * Бросает ошибку, если файл не является корректным PDF.
 */
export async function loadPdf(arrayBuffer) {
  const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  return { doc, numPages: doc.numPages };
}

/**
 * Инвертирует пиксели ImageData на месте: каждый канал RGB -> 255 - value,
 * альфа-канал не трогаем.
 */
function invertImageData(imageData) {
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255 - data[i];
    data[i + 1] = 255 - data[i + 1];
    data[i + 2] = 255 - data[i + 2];
  }
}

/**
 * Рендерит одну страницу PDF.js на canvas и инвертирует её цвета.
 * Возвращает { blob, width, height }: JPEG инвертированной страницы и её размер.
 */
async function renderInvertedPage(doc, pageNumber) {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: RENDER_SCALE });

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d');

  await page.render({ canvasContext: ctx, viewport }).promise;

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  invertImageData(imageData);
  ctx.putImageData(imageData, 0, 0);

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
  );
  const width = canvas.width;
  const height = canvas.height;

  // Освобождаем ресурсы страницы и canvas, чтобы не копить память на больших PDF.
  page.cleanup();
  canvas.width = 0;
  canvas.height = 0;

  return { blob, width, height };
}

/**
 * Обрабатывает PDF: инвертирует цвета страниц диапазона [start, end] и собирает
 * новый PDF. Если start/end не заданы, обрабатывается весь документ.
 *
 * @param {ArrayBuffer} arrayBuffer - исходный файл
 * @param {object} opts
 * @param {number} [opts.start] - первая страница (1-based, включительно)
 * @param {number} [opts.end] - последняя страница (1-based, включительно)
 * @param {(done:number,total:number)=>void} [opts.onProgress]
 * @returns {Promise<Uint8Array>} байты готового PDF
 */
export async function invertPdf(arrayBuffer, { start, end, onProgress } = {}) {
  const { doc, numPages } = await loadPdf(arrayBuffer);

  const from = start ?? 1;
  const to = end ?? numPages;
  const total = to - from + 1;

  const outPdf = await PDFDocument.create();

  let done = 0;
  for (let pageNumber = from; pageNumber <= to; pageNumber++) {
    const { blob, width, height } = await renderInvertedPage(doc, pageNumber);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const jpg = await outPdf.embedJpg(bytes);

    // Размер страницы = размеру растра; пропорции исходной страницы сохраняются,
    // так как viewport масштабируется равномерно.
    const outPage = outPdf.addPage([width, height]);
    outPage.drawImage(jpg, { x: 0, y: 0, width, height });

    done += 1;
    onProgress?.(done, total);
  }

  await doc.destroy();
  return outPdf.save();
}
