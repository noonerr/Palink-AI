import React from 'react';
import { CharacterView as CharacterViewShared } from './CharacterView';

type CharacterViewMobileProps = React.ComponentProps<typeof CharacterViewShared>;

export const CharacterViewMobile: React.FC<CharacterViewMobileProps> = (props) => {
  return <CharacterViewShared {...props} />;
};
