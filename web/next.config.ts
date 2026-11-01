import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // 상위 폴더에 다른 lockfile 이 있어도 web 을 기준으로 추적
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
