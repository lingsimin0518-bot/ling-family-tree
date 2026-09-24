package cn.lingshi.familytree.service.impl;

import cn.lingshi.familytree.dto.PageResponse;
import cn.lingshi.familytree.dto.PersonCreateRequest;
import cn.lingshi.familytree.dto.PersonResponse;
import cn.lingshi.familytree.dto.PersonUpdateRequest;
import cn.lingshi.familytree.entity.Person;
import cn.lingshi.familytree.mapper.FamilyMapper;
import cn.lingshi.familytree.mapper.PersonMapper;
import cn.lingshi.familytree.service.PersonService;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.List;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class PersonServiceImpl implements PersonService {
    private final PersonMapper personMapper;
    private final FamilyMapper familyMapper;

    public PersonServiceImpl(PersonMapper personMapper, FamilyMapper familyMapper) {
        this.personMapper = personMapper;
        this.familyMapper = familyMapper;
    }

    @Override
    @Transactional
    public PersonResponse create(PersonCreateRequest request) {
        requireFamily(request.familyId());
        Person person = new Person();
        person.setFamilyId(request.familyId());
        copyEditableFields(person, request.name(), request.gender(), request.generation(),
                request.birthDate(), request.deathDate(), request.biography());
        LocalDateTime now = LocalDateTime.now();
        person.setCreatedAt(now);
        person.setUpdatedAt(now);
        person.setDeleted(0);
        person.setVersion(1);
        personMapper.insert(person);
        return PersonResponse.from(person);
    }

    @Override
    public PersonResponse getById(Long id) {
        return PersonResponse.from(requirePerson(id));
    }

    @Override
    public PageResponse<PersonResponse> list(Long familyId, String name, Integer generation, long page, long size) {
        requireFamily(familyId);
        long safePage = Math.max(page, 1);
        long safeSize = Math.min(Math.max(size, 1), 100);
        LambdaQueryWrapper<Person> query = new LambdaQueryWrapper<Person>()
                .eq(Person::getFamilyId, familyId)
                .like(name != null && !name.isBlank(), Person::getName, name == null ? null : name.trim())
                .eq(generation != null, Person::getGeneration, generation)
                .orderByAsc(Person::getGeneration)
                .orderByAsc(Person::getBirthDate)
                .orderByAsc(Person::getId);
        Page<Person> result = personMapper.selectPage(Page.of(safePage, safeSize), query);
        List<PersonResponse> records = result.getRecords().stream().map(PersonResponse::from).toList();
        return new PageResponse<>(records, result.getTotal(), result.getCurrent(), result.getSize(), result.getPages());
    }

    @Override
    @Transactional
    public PersonResponse update(Long id, PersonUpdateRequest request) {
        requireFamily(request.familyId());
        Person existing = requirePerson(id);
        if (!existing.getFamilyId().equals(request.familyId())) {
            throw new IllegalArgumentException("人物不属于指定族谱");
        }
        Person update = new Person();
        update.setId(id);
        update.setFamilyId(request.familyId());
        copyEditableFields(update, request.name(), request.gender(), request.generation(),
                request.birthDate(), request.deathDate(), request.biography());
        update.setUpdatedAt(LocalDateTime.now());
        update.setVersion(request.version());
        if (personMapper.updateById(update) != 1) {
            throw new IllegalStateException("该人物已被其他操作修改，请刷新后重试");
        }
        return PersonResponse.from(requirePerson(id));
    }

    @Override
    @Transactional
    public void softDelete(Long id) {
        requirePerson(id);
        if (personMapper.deleteById(id) != 1) {
            throw new IllegalStateException("人物删除失败，请刷新后重试");
        }
    }

    private void requireFamily(Long familyId) {
        if (familyMapper.selectById(familyId) == null) {
            throw new IllegalArgumentException("族谱不存在：" + familyId);
        }
    }

    private Person requirePerson(Long id) {
        Person person = personMapper.selectById(id);
        if (person == null) {
            throw new IllegalArgumentException("人物不存在或已删除：" + id);
        }
        return person;
    }

    private void copyEditableFields(Person person, String name, String gender, Integer generation,
                                    LocalDate birthDate, LocalDate deathDate, String biography) {
        person.setName(name.trim());
        person.setGender(gender == null ? null : gender.trim());
        person.setGeneration(generation);
        person.setBirthDate(birthDate);
        person.setDeathDate(deathDate);
        person.setBiography(biography == null ? null : biography.trim());
    }
}
