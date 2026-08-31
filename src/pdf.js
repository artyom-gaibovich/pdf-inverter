import * as pdfjsLib from 'pdfjs-dist';
// Vite подставляет base (`/pdf-inverter/`) в этот URL, поэтому воркер грузится
// корректно и в dev, и из подкаталога GitHub Pages.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument } from 'pdf-lib';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// Целевой DPI растра при инверсии. Исходный PDF — 72 точки на дюйм, поэтому
// scale = TARGET_DPI / 72. Чем выше, тем меньше видно пиксели на зуме, но
// тяжелее файл и больше расход памяти.
const TARGET_DPI = 300;
const RENDER_SCALE = TARGET_DPI / 72;
// Качество JPEG для встраивания страниц в итоговый PDF.
const JPEG_QUALITY = 0.92;

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
 * Рендерит одну страницу PDF.js на canvas в высоком разрешении и инвертирует её.
 * Возвращает JPEG растра и РАЗМЕР СТРАНИЦЫ В ТОЧКАХ PDF (не в пикселях), чтобы
 * страница в итоговом PDF имела исходный физический размер, а картинка легла
 * с высоким DPI — тогда пиксели не лезут при увеличении.
 */
async function renderInvertedPage(doc, pageNumber) {
  const page = await doc.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 }); // размер в точках PDF
  const viewport = page.getViewport({ scale: RENDER_SCALE }); // размер растра

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
  const pointWidth = baseViewport.width;
  const pointHeight = baseViewport.height;

  // Освобождаем ресурсы страницы и canvas, чтобы не копить память на больших PDF.
  page.cleanup();
  canvas.width = 0;
  canvas.height = 0;

  return { blob, pointWidth, pointHeight };
}

/**
 * Приводит диапазон [start, end] к границам документа. Возвращает { from, to }.
 */
function resolveBounds(start, end, numPages) {
  const from = start ?? 1;
  const to = end ?? numPages;
  return { from, to };
}

/**
 * Инвертирует цвета страниц диапазона [start, end] и собирает новый PDF.
 * Страницы растрируются (см. TARGET_DPI). Если start/end не заданы —
 * обрабатывается весь документ.
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
  const { from, to } = resolveBounds(start, end, numPages);
  const total = to - from + 1;

  const outPdf = await PDFDocument.create();

  let done = 0;
  for (let pageNumber = from; pageNumber <= to; pageNumber++) {
    const { blob, pointWidth, pointHeight } = await renderInvertedPage(doc, pageNumber);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const jpg = await outPdf.embedJpg(bytes);

    // Размер страницы = исходный размер в точках; растр с высоким DPI
    // масштабируется на неё, поэтому изображение остаётся чётким на зуме.
    const outPage = outPdf.addPage([pointWidth, pointHeight]);
    outPage.drawImage(jpg, { x: 0, y: 0, width: pointWidth, height: pointHeight });

    done += 1;
    onProgress?.(done, total);
  }

  await doc.destroy();
  return outPdf.save();
}

/**
 * Нарезка без инверсии: копирует страницы диапазона [start, end] в новый PDF
 * БЕЗ растрирования — вектор и текст исходника сохраняются, качество не падает.
 * Если start/end не заданы — берётся весь документ.
 *
 * @param {ArrayBuffer} arrayBuffer - исходный файл
 * @param {object} opts
 * @param {number} [opts.start] - первая страница (1-based, включительно)
 * @param {number} [opts.end] - последняя страница (1-based, включительно)
 * @returns {Promise<Uint8Array>} байты готового PDF
 */
export async function slicePdf(arrayBuffer, { start, end } = {}) {
  const src = await PDFDocument.load(arrayBuffer);
  const numPages = src.getPageCount();
  const { from, to } = resolveBounds(start, end, numPages);

  const outPdf = await PDFDocument.create();
  const indices = [];
  for (let i = from; i <= to; i++) indices.push(i - 1); // pdf-lib индексирует с 0

  const copied = await outPdf.copyPages(src, indices);
  copied.forEach((page) => outPdf.addPage(page));

  return outPdf.save();
}
