/**
 * Zod schemas for structured LLM output.
 * These mirror the JSON schemas in data/_schema/ for use with generateObject().
 * AJV validation in validate.ts remains the final gate.
 */

import { z } from "zod";

// ─── Discover result ─────────────────────────────────────────────────────────

export const discoverResultSchema = z.object({
  csv_url: z.string().nullable(),
  schedule_urls: z.array(z.string()),
  separation_urls: z.array(z.string()),
  official_url: z.string(),
  city_id: z.string(),
  prefecture_id: z.string(),
});

export type DiscoverResultOutput = z.infer<typeof discoverResultSchema>;

// ─── Schedule ────────────────────────────────────────────────────────────────

const weeklyScheduleSchema = z.object({
  type: z.literal("weekly"),
  days: z
    .array(
      z.enum([
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
      ])
    )
    .min(1),
});

const monthlyScheduleSchema = z.object({
  type: z.literal("monthly"),
  pattern: z
    .array(
      z.object({
        week: z.number().int().min(1).max(5),
        day: z.enum([
          "monday",
          "tuesday",
          "wednesday",
          "thursday",
          "friday",
          "saturday",
          "sunday",
        ]),
      })
    )
    .min(1),
});

const appointmentScheduleSchema = z.object({
  type: z.literal("appointment"),
  contact_phone: z.string().optional(),
  contact_url: z.string().optional(),
  notes_ja: z.string().optional(),
});

const scheduleCategorySchema = z.object({
  category_id: z.string(),
  name_ja: z.string(),
  collection_days: z.union([
    weeklyScheduleSchema,
    monthlyScheduleSchema,
    appointmentScheduleSchema,
  ]),
  collection_time: z.string().optional(),
  bag_type: z.string().optional(),
  notes_ja: z.string().optional(),
});

const areaSchema = z.object({
  area_id: z.string(),
  area_name_ja: z.string(),
  categories: z.array(scheduleCategorySchema).min(1),
});

export const scheduleSchema = z.object({
  city_id: z.string(),
  city_name_ja: z.string(),
  source_url: z.string(),
  areas: z.array(areaSchema).min(1),
});

export type ScheduleOutput = z.infer<typeof scheduleSchema>;

// ─── Separation ──────────────────────────────────────────────────────────────

const itemSchema = z.object({
  name_ja: z.string(),
  notes_ja: z.string().optional(),
  keywords: z.array(z.string()).min(1),
});

const subcategorySchema = z.object({
  subcategory_id: z.string(),
  name_ja: z.string(),
  preparation_ja: z.string().optional(),
  items: z.array(itemSchema).optional(),
});

const categorySchema = z.object({
  category_id: z.string(),
  name_ja: z.string(),
  items: z.array(itemSchema).optional(),
  subcategories: z.array(subcategorySchema).optional(),
});

export const separationSchema = z.object({
  city_id: z.string(),
  categories: z.array(categorySchema).min(1),
});

export type SeparationOutput = z.infer<typeof separationSchema>;
