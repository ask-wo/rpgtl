import { RegistryProvider } from "@effect/atom-react";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { followSystemTheme } from "./app/theme.ts";
import { router } from "./router.tsx";
import "./index.css";

followSystemTheme();

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <RegistryProvider>
        <RouterProvider router={router} />
      </RegistryProvider>
    </StrictMode>,
  );
