import { EmbedBuilder, Colors } from "discord.js";

export function successEmbed(title: string, description: string) {
  return new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle(`✅ ${title}`)
    .setDescription(description)
    .setTimestamp();
}

export function errorEmbed(title: string, description: string) {
  return new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle(`❌ ${title}`)
    .setDescription(description)
    .setTimestamp();
}

export function infoEmbed(title: string, description: string) {
  return new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle(`ℹ️ ${title}`)
    .setDescription(description)
    .setTimestamp();
}

export function warningEmbed(title: string, description: string) {
  return new EmbedBuilder()
    .setColor(Colors.Yellow)
    .setTitle(`⚠️ ${title}`)
    .setDescription(description)
    .setTimestamp();
}

export function pendingEmbed(title: string, description: string) {
  return new EmbedBuilder()
    .setColor(Colors.Orange)
    .setTitle(`⏳ ${title}`)
    .setDescription(description)
    .setTimestamp();
}
