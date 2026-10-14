// Mixer commands (scope 'mixer': their keys work while the mixer is the
// active panel). They act on the selected insert through the controller.

export function registerMixerCommands(app, ctl, panel) {
  const sel = () => ctl.selected;
  const hasInsert = () => ctl.selected > 0;
  const focusAfter = () => panel()?.focusSelected?.();
  app.commands.register(
    {
      id: 'mixer.prevInsert',
      label: 'Select previous insert',
      keys: ['ArrowLeft'],
      scope: 'mixer',
      enabled: () => sel() > 0,
      run: () => {
        ctl.select(sel() - 1);
        focusAfter();
      },
    },
    {
      id: 'mixer.nextInsert',
      label: 'Select next insert',
      keys: ['ArrowRight'],
      scope: 'mixer',
      enabled: () => sel() < ctl.project.mixer.length - 1,
      run: () => {
        ctl.select(sel() + 1);
        focusAfter();
      },
    },
    {
      id: 'mixer.addInsert',
      label: 'Add mixer insert',
      scope: 'mixer',
      run: () => {
        ctl.addInsert();
        focusAfter();
      },
    },
    { id: 'mixer.rename', label: 'Rename insert...', keys: ['F2'], scope: 'mixer', run: () => panel()?.rename(sel()) },
    { id: 'mixer.mute', label: 'Mute selected insert', keys: ['M'], scope: 'mixer', checked: () => Boolean(ctl.track?.mute), run: () => ctl.toggleMute(sel()) },
    { id: 'mixer.solo', label: 'Solo selected insert', keys: ['S'], scope: 'mixer', enabled: hasInsert, checked: () => Boolean(ctl.track?.solo), run: () => ctl.solo(sel()) },
    { id: 'mixer.resetVolume', label: 'Reset insert volume', scope: 'mixer', run: () => ctl.resetVolume(sel()) },
    { id: 'mixer.resetPan', label: 'Reset insert pan and width', scope: 'mixer', run: () => ctl.resetPanWidth(sel()) },
    { id: 'mixer.routeMasterOnly', label: 'Route insert to master only', scope: 'mixer', enabled: hasInsert, run: () => ctl.routeMasterOnly(sel()) },
    { id: 'mixer.routeSelectedChannels', label: 'Route selected channels to this insert', keys: ['Mod+L'], scope: 'mixer', enabled: () => app.store.view.selectedChannels.size > 0, run: () => ctl.routeSelectedChannels(sel()) },
    { id: 'mixer.clearEffects', label: 'Clear insert effects', scope: 'mixer', enabled: () => Boolean(ctl.track?.fx.length), run: () => ctl.clearEffects(sel()) },
    {
      id: 'mixer.toggleEffectsPanel',
      label: 'Effects and routing panel',
      keys: ['Mod+Shift+E'],
      scope: 'mixer',
      checked: () => app.prefs.get('mixer')?.fx !== false,
      run: () => app.prefs.set('mixer', { ...(app.prefs.get('mixer') || {}), fx: app.prefs.get('mixer')?.fx === false }),
    },
  );
}
