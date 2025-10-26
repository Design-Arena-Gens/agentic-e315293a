"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { BrowserMultiFormatReader, DecodeHintType, BarcodeFormat } from "@zxing/library";
import Tesseract from "tesseract.js";

declare global { var cv: any }

function loadOpenCV(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") return reject(new Error("window missing"));
    if ((window as any).cv && (window as any).cv.Mat) return resolve();
    const script = document.createElement("script");
    script.src = "https://docs.opencv.org/4.x/opencv.js";
    script.async = true;
    script.onload = () => {
      const cv = (window as any).cv;
      if (!cv) return reject(new Error("OpenCV not loaded"));
      if (cv && cv['onRuntimeInitialized']) {
        cv['onRuntimeInitialized'] = () => resolve();
      } else {
        // some builds are ready immediately
        resolve();
      }
    };
    script.onerror = () => reject(new Error("Failed to load OpenCV.js"));
    document.head.appendChild(script);
  });
}

function fileToImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = url;
  });
}

function imageToCanvas(img: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  return canvas;
}

function orderQuadPoints(pts: any): any {
  // pts: MatOfPoint with 4 points
  // convert to array
  const arr: Array<{x:number,y:number}> = [];
  for (let i = 0; i < pts.data32S.length; i += 2) {
    arr.push({ x: pts.data32S[i], y: pts.data32S[i+1] });
  }
  // order by sum and diff
  const sum = (p: any) => p.x + p.y;
  const diff = (p: any) => p.y - p.x;
  const ordered: any = [];
  ordered[0] = arr.reduce((a,b) => sum(a) < sum(b) ? a : b); // top-left
  ordered[2] = arr.reduce((a,b) => sum(a) > sum(b) ? a : b); // bottom-right
  ordered[1] = arr.reduce((a,b) => diff(a) < diff(b) ? a : b); // top-right
  ordered[3] = arr.reduce((a,b) => diff(a) > diff(b) ? a : b); // bottom-left
  return ordered;
}

function distance(a: any, b: any) { return Math.hypot(a.x - b.x, a.y - b.y); }

async function matToBlob(mat: any, type: string = 'image/png'): Promise<Blob> {
  const canvas = document.createElement('canvas');
  cv.imshow(canvas, mat);
  return await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), type));
}

function rotateIfNeeded(mat: any): any {
  const w = mat.cols, h = mat.rows;
  // If card is taller than wide, rotate to landscape for consistency.
  if (h > w) {
    const rotated = new cv.Mat();
    cv.rotate(mat, rotated, cv.ROTATE_90_CLOCKWISE);
    mat.delete();
    return rotated;
  }
  return mat;
}

async function tryDecodeBarcodeFromBlob(blob: Blob): Promise<string | null> {
  try {
    const reader = new BrowserMultiFormatReader();
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.CODE_128,
      BarcodeFormat.CODE_39,
      BarcodeFormat.EAN_13,
      BarcodeFormat.EAN_8,
      BarcodeFormat.QR_CODE,
      BarcodeFormat.PDF_417,
      BarcodeFormat.DATA_MATRIX,
      BarcodeFormat.ITF
    ]);
    // @ts-ignore
    reader.hints = hints;

    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const result = await reader.decodeFromImage(img);
    return result?.getText() ?? null;
  } catch {
    return null;
  }
}

async function tryOcrSerialFromBlob(blob: Blob): Promise<string | null> {
  try {
    const { data } = await Tesseract.recognize(blob, 'eng', { logger: () => {} });
    const text = (data.text || '').replace(/\s+/g, ' ').trim();
    // Prefer long digit-alphanumeric sequences 6-24 chars
    const m = text.match(/[A-Z0-9]{6,24}/i);
    return m ? m[0] : (text ? text.split(' ').slice(0,4).join('_') : null);
  } catch {
    return null;
  }
}

export default function CardExtractor() {
  const [ready, setReady] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [sourcePreview, setSourcePreview] = useState<string | null>(null);
  const [results, setResults] = useState<Array<{ url: string; name: string; blob: Blob; w: number; h: number }>>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadOpenCV().then(() => setReady(true)).catch(() => setReady(false));
  }, []);

  const onFiles = useCallback(async (file: File) => {
    setProcessing(true); setProgress(0); setResults([]);
    try {
      const img = await fileToImage(file);
      setSourcePreview(URL.createObjectURL(file));
      const canvas = imageToCanvas(img);
      const src = cv.imread(canvas);

      // Preprocess
      const gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      const blurred = new cv.Mat();
      cv.GaussianBlur(gray, blurred, new cv.Size(5,5), 0, 0, cv.BORDER_DEFAULT);
      const edged = new cv.Mat();
      cv.Canny(blurred, edged, 50, 150);

      // Morph to close gaps
      const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5,5));
      const morphed = new cv.Mat();
      cv.morphologyEx(edged, morphed, cv.MORPH_CLOSE, kernel);

      // Find contours
      const contours = new cv.MatVector();
      const hierarchy = new cv.Mat();
      cv.findContours(morphed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      type Quad = { points: any, area: number };
      const quads: Quad[] = [];
      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const peri = cv.arcLength(cnt, true);
        const approx = new cv.Mat();
        cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
        if (approx.total() === 4 && cv.contourArea(approx, false) > (src.cols*src.rows)*0.01) {
          quads.push({ points: approx, area: cv.contourArea(approx, false) });
        } else {
          approx.delete();
        }
        cnt.delete();
      }

      // Sort largest to smallest
      quads.sort((a,b) => b.area - a.area);

      const out: Array<{ url: string; name: string; blob: Blob; w:number; h:number }> = [];

      for (let qi = 0; qi < quads.length; qi++) {
        setProgress(Math.round(((qi) / Math.max(1, quads.length)) * 100));
        const approx = quads[qi].points;
        const pts = orderQuadPoints(approx);
        const widthTop = distance(pts[0], pts[1]);
        const widthBottom = distance(pts[3], pts[2]);
        const maxWidth = Math.max(widthTop, widthBottom);
        const heightLeft = distance(pts[0], pts[3]);
        const heightRight = distance(pts[1], pts[2]);
        const maxHeight = Math.max(heightLeft, heightRight);

        const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
          0, 0,
          maxWidth, 0,
          maxWidth, maxHeight,
          0, maxHeight,
        ]);
        const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
          pts[0].x, pts[0].y,
          pts[1].x, pts[1].y,
          pts[2].x, pts[2].y,
          pts[3].x, pts[3].y,
        ]);

        const M = cv.getPerspectiveTransform(srcPts, dstPts);
        const warped = new cv.Mat();
        const dsize = new cv.Size(Math.round(maxWidth), Math.round(maxHeight));
        cv.warpPerspective(src, warped, M, dsize, cv.INTER_CUBIC, cv.BORDER_REPLICATE);

        // Clean borders slightly: optional slight crop of 1-2 px to avoid black edges
        const cropped = warped.roi(new cv.Rect(1, 1, Math.max(1, warped.cols-2), Math.max(1, warped.rows-2)));
        warped.delete();

        const oriented = rotateIfNeeded(cropped);

        const blob = await matToBlob(oriented, 'image/png');
        const w = oriented.cols; const h = oriented.rows;
        oriented.delete(); M.delete(); srcPts.delete(); dstPts.delete(); approx.delete();

        // Try barcode, then OCR naming
        let name = await tryDecodeBarcodeFromBlob(blob);
        if (!name) name = await tryOcrSerialFromBlob(blob);
        if (!name) name = `card_${qi+1}`;
        name = name.replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 64);
        const url = URL.createObjectURL(blob);
        out.push({ url, name: `${name}.png`, blob, w, h });
      }

      src.delete(); gray.delete(); blurred.delete(); edged.delete(); morphed.delete(); kernel.delete(); contours.delete(); hierarchy.delete();

      setResults(out);
      setProgress(100);
    } catch (e) {
      console.error(e);
      alert('Failed to process image. Try a different scan.');
    } finally {
      setProcessing(false);
    }
  }, []);

  const onPick = useCallback(() => fileRef.current?.click(), []);

  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) onFiles(f);
  }, [onFiles]);

  const downloadZip = useCallback(async () => {
    const zip = new JSZip();
    results.forEach((r) => zip.file(r.name, r.blob));
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cards.zip';
    a.click();
  }, [results]);

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row">
          <input ref={fileRef} type="file" accept="image/*" onChange={onFileChange} style={{ display: 'none' }} />
          <button className="button" disabled={!ready || processing} onClick={onPick}>{ready ? 'Choose Image' : 'Loading OpenCV...'}</button>
          <span className="muted">Accepted: PNG, JPG. Processed locally in your browser.</span>
        </div>
        <div>
          {results.length > 0 && (
            <button className="button" onClick={downloadZip}>Download ZIP ({results.length})</button>
          )}
        </div>
      </div>

      {sourcePreview && (
        <div style={{ marginTop: 16 }}>
          <img src={sourcePreview} alt="source" className="preview" />
        </div>
      )}

      {processing && (
        <div style={{ marginTop: 16 }}>
          <div className="progress"><span style={{ width: `${progress}%` }} /></div>
          <div className="muted" style={{ marginTop: 6 }}>Detecting and cropping cards... {progress}%</div>
        </div>
      )}

      {results.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="muted">Detected cards: {results.length}</div>
          </div>
          <div className="grid" style={{ marginTop: 12 }}>
            {results.map((r, idx) => (
              <div className="card" key={idx}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>{r.name}</strong>
                  <span className="badge">{r.w}×{r.h}</span>
                </div>
                <div style={{ marginTop: 8 }}>
                  <img src={r.url} alt={r.name} className="preview" />
                </div>
                <div className="row" style={{ marginTop: 8, justifyContent: 'space-between' }}>
                  <a className="button" href={r.url} download={r.name}>Download</a>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
