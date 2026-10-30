import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";
import "./features/workbenchDesign.css";
import "./features/sceneDraftReview.css";
import "./features/generationStageContent.css";
import "./features/review.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
