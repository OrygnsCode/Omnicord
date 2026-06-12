import type { Blueprint } from "./blueprint.js";

// Reference layouts: vetted starting points the AI client can fetch, adapt
// to the user's theme, and submit back as a blueprint. Each one keeps to
// features that work on a fresh non-community server, which is what a
// just-created guild is. Forum, stage, and announcement channels are
// deliberately absent; the rationale notes say what to upgrade once the
// owner enables Community.

export interface ReferenceLayout {
  id: string;
  title: string;
  audience: string;
  rationale: string;
  blueprint: Blueprint;
}

export const REFERENCE_LAYOUTS: ReferenceLayout[] = [
  {
    id: "gaming-community",
    title: "Gaming community",
    audience: "A game-centered community expecting dozens to hundreds of members.",
    rationale:
      "Read-only landing channels keep rules and announcements clean. " +
      "Separate LFG role lets people opt into pings without opening " +
      "everyone to mass mentions. A private staff area is standard. Once " +
      "the server enables Community, consider converting announcements to " +
      "an announcement channel and adding a forum for build guides.",
    blueprint: {
      name: "gaming-community",
      theme: "Friendly competitive gaming hub",
      roles: [
        { name: "Moderator", preset: "moderator", color: "#e67e22", hoist: true },
        { name: "Member", preset: "member", color: "#3498db" },
        { name: "LFG", preset: "none", mentionable: true, color: "#2ecc71" },
      ],
      categories: [
        {
          name: "Info",
          channels: [
            {
              name: "welcome",
              read_only: true,
              posting_roles: ["Moderator"],
              topic: "Start here. What this server is and where things live.",
            },
            {
              name: "rules",
              read_only: true,
              posting_roles: ["Moderator"],
              topic: "House rules. Read before posting.",
            },
            {
              name: "announcements",
              read_only: true,
              posting_roles: ["Moderator"],
              topic: "Server news and events.",
            },
          ],
        },
        {
          name: "General",
          channels: [
            { name: "general", topic: "Talk about anything." },
            { name: "clips-and-screenshots", topic: "Show off your plays." },
            { name: "memes", topic: "Keep it light." },
          ],
        },
        {
          name: "Game Rooms",
          channels: [
            {
              name: "lfg",
              topic: "Looking for group. Ping @LFG when you need players.",
              slowmode_seconds: 30,
            },
            { name: "Game Room 1", type: "voice" },
            { name: "Game Room 2", type: "voice" },
          ],
        },
        {
          name: "Staff",
          private_to: ["Moderator"],
          channels: [
            { name: "staff-chat", topic: "Coordination, off the record." },
            { name: "mod-log", topic: "Actions taken and why." },
          ],
        },
      ],
    },
  },
  {
    id: "product-support",
    title: "Product support",
    audience: "A company or project running customer support and feedback.",
    rationale:
      "Customers find answers in read-only info channels before asking. " +
      "Slowmode in the help channel keeps floods manageable. The team area " +
      "is private. Once Community is enabled, a forum channel for help " +
      "threads is a strong upgrade over a single help channel.",
    blueprint: {
      name: "product-support",
      theme: "Calm, organized product support",
      roles: [
        { name: "Support Team", preset: "moderator", color: "#9b59b6", hoist: true },
        { name: "Customer", preset: "member" },
      ],
      categories: [
        {
          name: "Start Here",
          channels: [
            {
              name: "welcome",
              read_only: true,
              posting_roles: ["Support Team"],
              topic: "What this server covers and how to get help.",
            },
            {
              name: "faq",
              read_only: true,
              posting_roles: ["Support Team"],
              topic: "Answers to the questions we hear most.",
            },
            {
              name: "status",
              read_only: true,
              posting_roles: ["Support Team"],
              topic: "Incidents and maintenance windows.",
            },
          ],
        },
        {
          name: "Support",
          channels: [
            {
              name: "help",
              topic: "Describe your problem; include what you tried.",
              slowmode_seconds: 15,
            },
            { name: "feature-requests", topic: "One request per message." },
            { name: "bug-reports", topic: "Steps to reproduce win prizes." },
          ],
        },
        {
          name: "Team",
          private_to: ["Support Team"],
          channels: [
            { name: "triage", topic: "What needs eyes today." },
            { name: "internal", topic: "Team talk." },
          ],
        },
      ],
    },
  },
  {
    id: "friends-hangout",
    title: "Friends hangout",
    audience: "A small private server for a friend group.",
    rationale:
      "Small groups need almost no structure. One text space, one media " +
      "dump, a couple of voice rooms. No roles beyond the default; add " +
      "them only when the group grows enough to need them.",
    blueprint: {
      name: "friends-hangout",
      theme: "Low-key space for friends",
      categories: [
        {
          name: "Chat",
          channels: [
            { name: "general", topic: "Everything goes here." },
            { name: "media", topic: "Pics, links, songs." },
          ],
        },
        {
          name: "Voice",
          channels: [
            { name: "Hangout", type: "voice" },
            { name: "Gaming", type: "voice" },
          ],
        },
      ],
    },
  },
];

export function getLayout(id: string): ReferenceLayout | undefined {
  return REFERENCE_LAYOUTS.find((l) => l.id === id);
}
