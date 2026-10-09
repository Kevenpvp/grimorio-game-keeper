import {
  Heart, Droplet, Dumbbell, Wind, Shield, Zap, ShieldHalf, Flame, Brain, Sparkles, Circle, Activity, Eye,
  type LucideIcon,
} from "lucide-react";

const map: Record<string, LucideIcon> = {
  heart: Heart, droplet: Droplet, dumbbell: Dumbbell, wind: Wind, shield: Shield, zap: Zap,
  "shield-half": ShieldHalf, flame: Flame, brain: Brain, sparkles: Sparkles, activity: Activity, eye: Eye,
};

export function AttrIcon({ name, className }: { name: string; className?: string }) {
  const I = map[name] ?? Circle;
  return <I className={className} />;
}

/** Bar tone per attribute key. */
export function barTone(key: string) {
  if (key === "hp") return "bg-blood";
  if (key === "mana") return "bg-arcane";
  if (key === "body") return "bg-vital";
  if (key === "sanity") return "bg-mind";
  return "bg-gold";
}
