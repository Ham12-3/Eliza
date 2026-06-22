export const metadata = {
  title: "Elizabeth line — live 3D simulation",
  description:
    "Real-time 3D simulation of the Elizabeth line: every station connected by real track geometry, trains moving from live TfL predictions.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
