import { CommunitySection } from "@/components/CommunitySection";
import { FeedSection } from "@/components/FeedSection";
import { Footer } from "@/components/Footer";
import { GoalSection } from "@/components/GoalSection";
import { Hero } from "@/components/Hero";
import { HistorySection } from "@/components/HistorySection";
import { Marquee } from "@/components/Marquee";
import { Nav } from "@/components/Nav";
import { SecuritySection } from "@/components/SecuritySection";
import { VoteSection } from "@/components/VoteSection";

export default function Home() {
  return (
    <>
      <Nav />
      <Hero />
      <Marquee />
      <VoteSection />
      <SecuritySection />
      <FeedSection />
      <HistorySection />
      <CommunitySection />
      <GoalSection />
      <Footer />
    </>
  );
}
