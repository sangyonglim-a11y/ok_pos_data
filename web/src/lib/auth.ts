export function assertPin(pin: string | null | undefined) {
  const expected = process.env.APP_PIN || "";
  if (!expected) {
    throw new Error("APP_PIN 환경변수가 없습니다.");
  }
  if (!pin || pin.trim() !== expected) {
    throw new Error("비밀번호가 올바르지 않습니다.");
  }
}
