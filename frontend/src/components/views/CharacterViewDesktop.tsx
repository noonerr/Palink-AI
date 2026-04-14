import React from 'react';
import { CharacterView as CharacterViewShared } from './CharacterView';

type CharacterViewDesktopProps = React.ComponentProps<typeof CharacterViewShared>;

export const CharacterViewDesktop: React.FC<CharacterViewDesktopProps> = (props) => {
  return <CharacterViewShared {...props} />;
};
