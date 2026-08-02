import { cookies } from "next/headers";
import { CommunitySection } from "@/components/CommunitySection";
import { FeedSection } from "@/components/FeedSection";
import { Footer } from "@/components/Footer";
import { GoalSection } from "@/components/GoalSection";
import { Hero } from "@/components/Hero";
import { HistorySection } from "@/components/HistorySection";
import { Marquee } from "@/components/Marquee";
import { Nav } from "@/components/Nav";
import { RoadmapSection } from "@/components/RoadmapSection";
import { SecuritySection } from "@/components/SecuritySection";
import { VoteSection } from "@/components/VoteSection";
import { getTally, getVotedChoice } from "@/lib/votes";

export default async function Home() {
  const voterId = (await cookies()).get("taco_voter_id")?.value;
  const [tally, votedChoice] = await Promise.all([getTally(), getVotedChoice(voterId)]);

  return (
    <>
      <Nav />
      <Hero tally={tally} />
      <Marquee />
      <VoteSection tally={tally} votedChoice={votedChoice} />
      <SecuritySection />
      <FeedSection />
      <HistorySection />
      <RoadmapSection />
      <CommunitySection />
      <GoalSection />
      <Footer />
    </>
  );
}
