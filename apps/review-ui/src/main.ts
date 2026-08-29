import { startReviewApp } from "./review-app";

const root = document.querySelector<HTMLElement>("#review-app");
if (root === null) throw new Error("Review UI root is unavailable.");

startReviewApp(root, import.meta.env.VITE_BETA_TENANT_ID);
