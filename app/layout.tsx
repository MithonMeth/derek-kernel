import type { Metadata } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
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
