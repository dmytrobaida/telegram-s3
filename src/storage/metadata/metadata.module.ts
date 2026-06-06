import { Module } from '@nestjs/common';
import { MetadataStore } from './metadata.store';

@Module({
  providers: [MetadataStore],
  exports: [MetadataStore],
})
export class MetadataModule {}
