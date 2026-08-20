import { Config } from "@remotion/cli/config";

// Cấu hình render — xem skill `remotion-assemble` + docs/API.md (mục Ghi chú cho render Remotion).
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.setEntryPoint("./src/index.ts");
