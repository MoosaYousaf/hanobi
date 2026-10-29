// Display names shared by the picker, the thread header, and message metadata.
export const routeLabel = { subscription: 'Subscription', key: 'API key', local: 'Local' };

export function modelLabel(app, connectionId, model) {
  const connection = app.connections.find(c => c.id === connectionId);
  const preset = connection && app.presets[connection.preset];
  const name = preset?.models?.find(m => m.id === model)?.label || model || 'Default model';
  return connection ? `${name} · ${connection.name}` : name;
}
