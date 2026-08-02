import type { Metadata } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import { connection } from "next/server";
import { siteConfig } from "@/lib/site-config";
import { CustomCursor } from "@/components/CustomCursor";
import { Loader } from "@/components/Loader";
import { ScrollReveal } from "@/components/ScrollReveal";
import { SmoothScrollLinks } from "@/components/SmoothScrollLinks";
import "./globals.css";

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  axes: ["wdth"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

export const metadata: Metadata = {
  metadataBase: new URL(`https://${siteConfig.canonicalDomain}`),
  title: "$TACO — The Community TACO Indicator",
  description:
    "A community sentiment indicator for a Solana memecoin. Token holders vote on whether Trump will back down on a live situation.",
  alternates: { canonical: "/" },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Forces dynamic rendering so proxy.ts's per-request CSP nonce is available
  // when Next.js renders its own inline hydration scripts. See proxy.ts.
  await connection();

  return (
    <html lang="en" className={`${archivo.variable} ${jetbrainsMono.variable}`}>
      <body>
        <Loader />
        <CustomCursor />
        {children}
        <ScrollReveal />
        <SmoothScrollLinks />
      </body>
    </html>
  );
}
