import { useEffect, useLayoutEffect } from "react";

export const useCommitEffect = typeof document === "undefined" ? useEffect : useLayoutEffect;
