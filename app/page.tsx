"use client";
import React, { useState } from "react";
import dynamic from "next/dynamic";

const CardExtractor = dynamic(() => import("@/components/CardExtractor"), { ssr: false });

export default function Page() {
  const [key, setKey] = useState(0);
  return (
    <div className="container">
      <div className="header" style={{ marginBottom: 16 }}>
        <h1 className="h1">Card Extractor</h1>
        <span className="badge">OpenCV + ZXing + OCR</span>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <p className="muted">Upload a scanned image containing multiple rectangular cards. The app detects, crops, deskews, and names each card image. No content is altered.</p>
      </div>
      <CardExtractor key={key} />
    </div>
  );
}
