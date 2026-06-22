import { tfl } from "@/lib/tflProxy";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await tfl("status", "/Line/elizabeth/Status", 60000);
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json({ error: "TfL status failed", detail: err.message }, { status: 502 });
  }
}
