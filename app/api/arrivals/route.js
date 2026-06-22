import { tfl } from "@/lib/tflProxy";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await tfl("arrivals", "/Line/elizabeth/Arrivals", 15000);
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json({ error: "TfL arrivals failed", detail: err.message }, { status: 502 });
  }
}
