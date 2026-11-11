import type { Playtime } from "@rpgtl/contracts";

const duration = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return "less than a minute";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
};

export const playtimeText = ({ seconds, lastPlayed }: Playtime) =>
  `Played ${duration(seconds)}, last on ${new Date(lastPlayed).toLocaleDateString(undefined, {
    dateStyle: "medium",
  })}`;
