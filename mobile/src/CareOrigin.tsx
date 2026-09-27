import { Text, View, StyleSheet } from "react-native";
import type { CareRow } from "./contracts";

export function CareOrigin({
  row,
  prefix = "Recorded",
}: {
  row: CareRow;
  prefix?: string;
}) {
  const source = row.provenance as Record<string, unknown> | undefined;
  if (!source || typeof source !== "object") return null;
  const names: Record<string, string> = {
    phone: "Parse phone",
    pendant: "Parse cardholder",
    dashboard: "care dashboard",
  };
  const name = names[String(source.type)];
  return (
    <Text style={styles.caption}>
      {name ? `${prefix} via ${name}` : "Source not recorded"}
    </Text>
  );
}

export function CareHistory({ row }: { row: CareRow }) {
  const entries = ["transitions", "resolutions", "report_history"].flatMap(
    (key) => (Array.isArray(row[key]) ? (row[key] as CareRow[]) : []),
  );
  if (!entries.length) return null;
  return (
    <View style={styles.history}>
      <Text style={styles.caption}>Recent confirmed updates</Text>
      {entries.slice(-3).map((entry) => (
        <View key={entry.id} style={styles.entry}>
          <Text style={styles.caption}>
            {String(
              entry.reported_outcome ||
                entry.to_state ||
                entry.report_state ||
                "Confirmed update",
            ).replaceAll("_", " ")}
          </Text>
          {entry.appointment_date ? (
            <Text style={styles.caption}>
              Appointment: {String(entry.appointment_date)}
            </Text>
          ) : null}
          {entry.completion_date ? (
            <Text style={styles.caption}>
              Completed: {String(entry.completion_date)}
            </Text>
          ) : null}
          {entry.taken_time_text ? (
            <Text style={styles.caption}>
              Reported timing: {String(entry.taken_time_text)}
            </Text>
          ) : null}
          <CareOrigin row={entry} />
        </View>
      ))}
    </View>
  );
}
const styles = StyleSheet.create({
  caption: { fontSize: 18, lineHeight: 26, color: "#756C60" },
  history: { gap: 10, marginTop: 6 },
  entry: {
    gap: 4,
    paddingLeft: 12,
    borderLeftWidth: 1,
    borderLeftColor: "#D0B5A1",
  },
});
