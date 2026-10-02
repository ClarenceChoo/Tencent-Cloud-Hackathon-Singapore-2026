import { useState } from 'react';
import { Button, Platform, ScrollView, Text, View } from 'react-native';
import { clearProbe, inspectProbe, integrityProbe, prepareProbe, writeCheckpoint } from './probe';

export default function VaultProbe() {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [observations, setObservations] = useState<string[]>([]);
  async function run(name: string, action: () => Promise<unknown>) {
    setBusy(true);
    try {
      const observation = await action();
      setObservations(current => [...current, `${new Date().toISOString()} ${name}: ${JSON.stringify(observation ?? 'finished')}`]);
    } catch {
      setObservations(current => [...current, `${new Date().toISOString()} ${name}: unavailable/failed (inspect native fixture privately)`]);
    } finally { setBusy(false); }
  }
  return <ScrollView contentContainerStyle={{ padding: 28, gap: 18 }}>
    <Text accessibilityRole="header" style={{ fontSize: 28 }}>Parse vault primitive probe</Text>
    <Text>{Platform.OS} · Separate fictional fixture. No microphone, account, or upload.</Text>
    <Text>These observations cannot pass G1. This SDK candidate has no verified backup exclusions, durable transaction or retention policy.</Text>
    <Button title="This is the dedicated fictional probe app" disabled={enabled} onPress={() => setEnabled(true)}/>
    <View style={{ gap: 12 }}>
      <Button title="Reset and prepare fictional key" disabled={!enabled || busy} onPress={() => void run('prepare', prepareProbe)}/>
      <Button title="Stop after temporary ciphertext write" disabled={!enabled || busy} onPress={() => void run('temporary write', () => writeCheckpoint('temporary_write'))}/>
      <Button title="Stop after audio rename" disabled={!enabled || busy} onPress={() => void run('audio rename', () => writeCheckpoint('audio_rename'))}/>
      <Button title="Write encrypted journal checkpoint" disabled={!enabled || busy} onPress={() => void run('journal commit', () => writeCheckpoint('journal_commit'))}/>
      <Button title="Inspect after kill/restart or unlock" disabled={!enabled || busy} onPress={() => void run('inspect', inspectProbe)}/>
      <Button title="Check tamper and identity rejection" disabled={!enabled || busy} onPress={() => void run('integrity', integrityProbe)}/>
      <Button title="Delete this probe's key and files" disabled={!enabled || busy} onPress={() => void run('cleanup', clearProbe)}/>
    </View>
    {observations.map((line, index) => <Text key={index} selectable>{line}</Text>)}
  </ScrollView>;
}
